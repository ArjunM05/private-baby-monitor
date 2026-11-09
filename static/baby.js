// Baby unit: captures camera + mic, analyses them ON THIS DEVICE, and alerts the parent device.
// Nothing is recorded: no MediaRecorder, no uploads, no storage of frames or audio.
(() => {
  'use strict';
  const getElement = (id) => document.getElementById(id);

  // ---- sound detection settings
  const MINIMUM_ALERT_LEVEL_DB = -52;        // never alert below this level (dBFS), however quiet the room is
  const CALIBRATION_TICKS = 30;              // 3 s of calibration at 10 ticks per second
  const ANALYSED_BAND_HZ = { low: 80, high: 8000 };
  const VOICE_BAND_HZ = { low: 250, high: 4000 };   // where crying and voices live
  const REQUIRED_VOICE_BAND_SHARE = 0.45;    // share of the sound energy that must be in the voice band
  const SOUND_WINDOW_TICKS = 30;             // look at the last 3 s...
  const LOUD_TICKS_REQUIRED_FOR_ALERT = 12;  // ...and alert if about 1.2 s of it was loud
  const DEFAULT_SOUND_SENSITIVITY = 6;

  // ---- movement detection settings
  // Movement detection works on a tiny greyscale copy of each camera frame.
  const MOVEMENT_FRAME_WIDTH = 64;
  const MOVEMENT_FRAME_HEIGHT = 48;
  const PIXEL_CHANGE_THRESHOLD = 25;         // brightness change (0-255) that counts as "this pixel changed"
  const MOVEMENT_PERCENT_THRESHOLD = 4;      // share of changed pixels that counts as "movement"
  const MOVEMENT_WINDOW_TICKS = 8;           // last 4 s at 2 ticks per second
  const MOVEMENT_TICKS_REQUIRED_FOR_ALERT = 5;

  // ---- movement box settings
  // The frame is split into a grid of small cells; a cell is "moving" when enough of its pixels changed.
  // The box is drawn around all groups of touching moving cells that are big enough not to be noise.
  const BOX_GRID_COLUMNS = 16;
  const BOX_GRID_ROWS = 12;                  // 16 x 12 cells of 4 x 4 pixels on the 64 x 48 frame
  const CELL_MOVING_PIXEL_SHARE = 0.25;      // share of a cell's pixels that must have changed
  const MIN_CELLS_IN_MOVING_AREA = 3;        // smaller specks are treated as noise
  const BOX_HOLD_TICKS = 3;                  // keep showing the box for 1.5 s after the movement stops
  const BOX_SMOOTHING = 0.6;                 // how far the box moves toward its new position on each update

  const ALERT_COOLDOWN_MILLISECONDS = 10000;
  const SCREEN_DIM_DELAY_MILLISECONDS = 30000;

  // ---- talk-back settings (a parent speaks to the baby through this device)
  const ALERT_PAUSE_AFTER_TALK_MILLISECONDS = 3000;   // the parent's voice is still fading out of the room
  const MAX_WAITING_ICE_CANDIDATES = 50;

  // ---- movement clip settings (OFF unless switched on; clips are kept in this page's memory only)
  const CLIP_SECONDS_BEFORE_MOVEMENT = 10;                 // every clip starts at least this long before the movement
  const CLIP_SECONDS_AFTER_MOVEMENT = 20;                  // ...and ends this long after the LAST movement
  const MAX_CLIP_SECONDS_AFTER_FIRST_MOVEMENT = 60;        // a very long movement is cut here (clips stay a sensible size)
  const ROLLING_RECORDER_START_GAP_MILLISECONDS = CLIP_SECONDS_BEFORE_MOVEMENT * 1000;
  const ROLLING_RECORDER_LIFETIME_MILLISECONDS = 2 * ROLLING_RECORDER_START_GAP_MILLISECONDS;
  const MAX_SAVED_CLIPS = 10;
  const MAX_SAVED_CLIP_BYTES = 40 * 1024 * 1024;           // the oldest clips are dropped beyond this
  const CLIP_VIDEO_BITS_PER_SECOND = 600000;
  const CLIP_AUDIO_BITS_PER_SECOND = 32000;
  const CLIP_MIME_TYPES = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  const CLIP_CHUNK_BYTES = 16 * 1024;                      // safe message size for every browser's data channel
  const CLIP_CHANNEL_BUFFER_LIMIT_BYTES = 1024 * 1024;

  const deviceStorage = {
    read(key, fallback) {
      try {
        const storedValue = localStorage.getItem(key);
        return storedValue === null ? fallback : storedValue;
      } catch { return fallback; }
    },
    write(key, value) {
      try { localStorage.setItem(key, value); } catch { /* storage unavailable: ignore */ }
    },
  };
  const settings = {
    soundSensitivity: +deviceStorage.read('soundSensitivity', DEFAULT_SOUND_SENSITIVITY) || DEFAULT_SOUND_SENSITIVITY,
    movementAlertsEnabled: deviceStorage.read('movementAlertsEnabled', '0') === '1',
    recordClipsEnabled: deviceStorage.read('recordClipsEnabled', '0') === '1',
  };

  // Why the server turned this device away, in words for the person looking at the screen.
  const JOIN_DENIED_MESSAGES = {
    'locked': 'Too many wrong PINs. Wait 5 minutes and try again.',
    'baby-unit-already-in-use': 'Another device is already the baby unit, and only one device can be at a time. ' +
      'If that device is switched off, wait about 30 seconds and try again.',
    'replaced-by-newer-session': 'The baby unit was opened again in another window on this device, so this window has stopped.',
    'invalid-request': 'Something went wrong. Reload this page and try again.',
  };

  // Identifies this physical device (not this page load), so the server lets it reconnect
  // after a Wi-Fi drop or a reload, while refusing any other device.
  function getOrCreateBabyUnitId() {
    const savedId = deviceStorage.read('babyUnitId', '');
    if (savedId) return savedId;
    const newId = window.crypto && crypto.randomUUID
      ? crypto.randomUUID()
      : String(Math.random()).slice(2) + String(Date.now());
    deviceStorage.write('babyUnitId', newId);
    return newId;
  }
  const babyUnitId = getOrCreateBabyUnitId();

  let mediaStream = null, audioContext = null, audioAnalyser = null, serverConnection = null;
  let waveformSamples = null, frequencySpectrum = null;
  let repeatingTimers = [], dimScreenTimer = null;
  let backgroundLevelDb = -70, alertThresholdDb = MINIMUM_ALERT_LEVEL_DB, soundLevelDb = -120;
  let calibrationTicksDone = 0, calibrationLevelSum = 0;
  let movementPercent = 0, previousGrayFrame = null;
  let shownMovementBox = null, ticksWithoutMovement = 0, wasBoxSentOnLastUpdate = false;
  const recentSoundTicks = [], recentMovementTicks = [], lastAlertTimeByKind = {};
  const liveViewConnections = new Map();       // parent device id -> RTCPeerConnection
  const pendingIceCandidates = new Map();      // parent device id -> candidates that arrived too early
  const talkConnections = new Map();           // parent device id -> RTCPeerConnection carrying that parent's voice
  const pendingTalkCandidates = new Map();     // parent device id -> talk candidates that arrived too early
  let talkAlertPauseEndTime = 0;               // sound alerts stay paused until this time (ms since 1970)
  const savedClips = [];                       // { id, startedAt, durationSeconds, blob }, oldest first. Memory only.
  const clipConnections = new Map();           // parent device id -> { peerConnection, channel, isSending }
  const pendingClipCandidates = new Map();     // parent device id -> clip candidates that arrived too early
  // While recording is switched on, two recorders run at once, started 10 s apart and thrown away after 20 s,
  // so there is always a recording that began 10-20 s ago. Their data stays in memory and is dropped unless
  // movement is detected. Each entry: { recorder, chunks, startedAt, shouldDiscard, onFinished }.
  let rollingRecordings = [];
  let activeClip = null;                       // { recording, firstMovementAt, lastMovementAt, hasSustainedMovement }
  let clipCounter = 0;
  const movementCanvas = document.createElement('canvas');
  movementCanvas.width = MOVEMENT_FRAME_WIDTH;
  movementCanvas.height = MOVEMENT_FRAME_HEIGHT;
  const movementCanvasContext = movementCanvas.getContext('2d', { willReadFrequently: true });

  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
  const sumOf = (numbers) => numbers.reduce((total, number) => total + number, 0);
  const showSetupError = (message) => { getElement('setupError').textContent = message; };

  getElement('startButton').addEventListener('click', startMonitoring);
  getElement('stopButton').addEventListener('click', () => stopMonitoring(''));
  getElement('dimScreenButton').addEventListener('click', dimScreen);

  // ---------------------------------------------------------------- start / stop
  async function startMonitoring() {
    const pin = getElement('pin').value.trim();
    if (!pin) return showSetupError('Enter the PIN shown on the computer running the server.');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return showSetupError('The camera needs a secure connection. Open the https:// link and accept the certificate warning.');
    }
    showSetupError('');
    getElement('startButton').disabled = true;

    // Create the audio context right now, while the tap still counts as a user gesture.
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass();
    audioContext.resume().catch(() => {});

    const audioConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    const videoConstraints = {
      facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15 },
    };
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: videoConstraints });
    } catch (cameraError) {
      if (cameraError.name === 'NotFoundError' || cameraError.name === 'OverconstrainedError') {
        try {
          mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });   // no camera: audio only
        } catch (microphoneError) {
          return abortStartup('Could not open the microphone (' + microphoneError.name + ').');
        }
      } else {
        return abortStartup('Could not open camera/microphone (' + cameraError.name + '). Allow access and try again.');
      }
    }
    if (mediaStream.getAudioTracks().length === 0) return abortStartup('No microphone found.');

    getElement('setupSection').hidden = true;
    getElement('liveSection').hidden = false;
    const cameraPreview = getElement('cameraPreview');
    if (mediaStream.getVideoTracks().length) {
      cameraPreview.srcObject = new MediaStream(mediaStream.getVideoTracks());
      cameraPreview.play().catch(() => {});
    } else {
      getElement('cameraFrame').hidden = true;
    }

    // The analyser is fed by the microphone but NOT connected to the speakers (no feedback, no playback).
    const microphoneSource = audioContext.createMediaStreamSource(new MediaStream(mediaStream.getAudioTracks()));
    audioAnalyser = audioContext.createAnalyser();
    audioAnalyser.fftSize = 2048;
    audioAnalyser.smoothingTimeConstant = 0.2;
    microphoneSource.connect(audioAnalyser);
    waveformSamples = new Float32Array(audioAnalyser.fftSize);
    frequencySpectrum = new Float32Array(audioAnalyser.frequencyBinCount);

    window.MonitorApp.keepScreenAwake();
    serverConnection = window.MonitorApp.createServerConnection('baby', pin, {
      onConnectionStateChange: handleConnectionStateChange,
      onJoinDenied: handleJoinDenied,
      onServerMessage: handleServerMessage,
    }, babyUnitId);
    serverConnection.connect();
    repeatingTimers = [
      setInterval(analyzeSound, 100),
      setInterval(analyzeMovement, 500),
      setInterval(sendStatusToParents, 1000),
      setInterval(keepRollingRecordingsFresh, 1000),
    ];
    showSettings();
    keepRollingRecordingsFresh();   // start the "10 s before" recording at once if clips are switched on
    scheduleScreenDimming();
  }

  function abortStartup(errorMessage) {
    if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
    if (mediaStream) { mediaStream.getTracks().forEach((track) => track.stop()); mediaStream = null; }
    getElement('startButton').disabled = false;
    showSetupError(errorMessage);
  }

  function stopMonitoring(messageToShow) {
    repeatingTimers.forEach(clearInterval);
    repeatingTimers = [];
    clearTimeout(dimScreenTimer);
    [...liveViewConnections.keys()].forEach(stopSendingLiveView);
    [...talkConnections.keys()].forEach(stopReceivingTalk);
    removeAllClips();                                   // clips never outlive monitoring
    [...clipConnections.keys()].forEach(stopClipConnection);
    if (serverConnection) { serverConnection.disconnect(); serverConnection = null; }
    if (mediaStream) { mediaStream.getTracks().forEach((track) => track.stop()); mediaStream = null; }
    if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
    getElement('cameraPreview').srcObject = null;
    getElement('dimOverlay').hidden = true;
    getElement('liveSection').hidden = true;
    getElement('setupSection').hidden = false;
    getElement('startButton').disabled = false;
    backgroundLevelDb = -70; calibrationTicksDone = 0; calibrationLevelSum = 0; previousGrayFrame = null;
    recentSoundTicks.length = 0; recentMovementTicks.length = 0; talkAlertPauseEndTime = 0;
    shownMovementBox = null; ticksWithoutMovement = 0; wasBoxSentOnLastUpdate = false;
    window.MonitorApp.showMovementBox(getElement('movementBox'), null);
    showSetupError(messageToShow);
  }

  // ---------------------------------------------------------------- connection to the server
  function handleConnectionStateChange(state) {
    const badge = getElement('connectionBadge');
    badge.textContent = state === 'online' ? 'connected' : 'reconnecting…';
    badge.className = 'pill ' + (state === 'online' ? 'ok' : 'bad');
    if (state !== 'online') {
      [...liveViewConnections.keys()].forEach(stopSendingLiveView);
      [...talkConnections.keys()].forEach(stopReceivingTalk);
      [...clipConnections.keys()].forEach(stopClipConnection);   // the clips stay; parents reconnect and list them again
    }
  }

  function handleJoinDenied(reason) {
    stopMonitoring(JOIN_DENIED_MESSAGES[reason] || 'Wrong PIN.');
  }

  function handleServerMessage(message) {
    switch (message.type) {
      case 'start-live-view':
        startSendingLiveView(message.parentDeviceId, !!message.includeVideo);
        break;
      case 'stop-live-view':
        stopSendingLiveView(message.parentDeviceId);
        break;
      case 'webrtc-signal':
        handleWebRtcSignalFromParent(message.parentDeviceId, message.signal);
        break;
      case 'talk-signal':
        handleTalkSignalFromParent(message.parentDeviceId, message.signal);
        break;
      case 'stop-talking':
        stopReceivingTalk(message.parentDeviceId);
        break;
      case 'clip-signal':
        handleClipSignalFromParent(message.parentDeviceId, message.signal);
        break;
      case 'stop-clips':
        stopClipConnection(message.parentDeviceId);
        break;
      case 'change-settings':
        settings.soundSensitivity = clamp(Math.round(+message.soundSensitivity) || settings.soundSensitivity, 1, 10);
        settings.movementAlertsEnabled = !!message.movementAlertsEnabled;
        applyRecordClipsSetting(!!message.recordClipsEnabled);
        saveSettings();
        showSettings();
        break;
      case 'parent-count': {
        const badge = getElement('parentCountBadge');
        badge.textContent = message.count > 0 ? message.count + ' connected' : 'NONE - alerts will not reach anyone';
        badge.className = 'pill ' + (message.count > 0 ? 'ok' : 'bad');
        break;
      }
      default: break;
    }
  }

  function sendStatusToParents() {
    if (!mediaStream) return;
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
    const isMicrophoneWorking =
      mediaStream.getAudioTracks().every((track) => track.readyState === 'live') && audioContext.state === 'running';
    serverConnection.sendMessage({
      type: 'status',
      soundLevelDb: Math.round(soundLevelDb),
      alertThresholdDb: Math.round(alertThresholdDb),
      movementPercent: Math.round(movementPercent * 10) / 10,
      soundSensitivity: settings.soundSensitivity,
      movementAlertsEnabled: settings.movementAlertsEnabled,
      recordClipsEnabled: settings.recordClipsEnabled,
      isCalibrating: calibrationTicksDone < CALIBRATION_TICKS,
      isMicrophoneWorking,
    });
  }

  function sendAlert(alertKind) {
    const now = Date.now();
    if (now - (lastAlertTimeByKind[alertKind] || 0) < ALERT_COOLDOWN_MILLISECONDS) return;
    lastAlertTimeByKind[alertKind] = now;
    serverConnection.sendMessage({ type: 'alert', alertKind });
    getElement('lastAlertText').textContent = alertKind + ' at ' + new Date().toLocaleTimeString();
  }

  // ---------------------------------------------------------------- sound detection
  // Signal processing, not a trained model: an alert fires when the sound is clearly above this
  // room's own (adaptive) background level AND mostly in the 250-4000 Hz band where crying and
  // voices live AND it lasts at least ~1.2 s within a 3 s window.
  function analyzeSound() {
    if (!audioAnalyser) return;
    audioAnalyser.getFloatTimeDomainData(waveformSamples);
    let sumOfSquares = 0;
    for (let index = 0; index < waveformSamples.length; index++) sumOfSquares += waveformSamples[index] ** 2;
    soundLevelDb = 10 * Math.log10(sumOfSquares / waveformSamples.length + 1e-12);   // RMS level in dBFS

    audioAnalyser.getFloatFrequencyData(frequencySpectrum);
    const hertzPerBin = audioContext.sampleRate / audioAnalyser.fftSize;
    let voiceBandEnergy = 0, totalEnergy = 0;
    for (let binIndex = 1; binIndex < frequencySpectrum.length; binIndex++) {
      const frequencyHz = binIndex * hertzPerBin;
      if (frequencyHz < ANALYSED_BAND_HZ.low || frequencyHz > ANALYSED_BAND_HZ.high) continue;
      const binEnergy = Math.pow(10, frequencySpectrum[binIndex] / 10);
      totalEnergy += binEnergy;
      if (frequencyHz >= VOICE_BAND_HZ.low && frequencyHz <= VOICE_BAND_HZ.high) voiceBandEnergy += binEnergy;
    }
    const voiceBandShare = totalEnergy > 0 ? voiceBandEnergy / totalEnergy : 0;

    showLevels();
    if (calibrationTicksDone < CALIBRATION_TICKS) {   // learn the room's background level first
      calibrationLevelSum += soundLevelDb;
      calibrationTicksDone++;
      if (calibrationTicksDone === CALIBRATION_TICKS) backgroundLevelDb = calibrationLevelSum / CALIBRATION_TICKS;
      return;
    }

    const alertMarginDb = 24 - 2 * settings.soundSensitivity;   // sensitivity 10 -> 4 dB, 6 -> 12 dB, 1 -> 22 dB
    const isLouderThanTrigger = soundLevelDb > backgroundLevelDb + alertMarginDb;
    alertThresholdDb = Math.max(backgroundLevelDb + alertMarginDb, MINIMUM_ALERT_LEVEL_DB);
    // Background level: follows the room DOWN quickly (quiet returns), but UP only slowly (~30 s),
    // and slower still while a sound is above the trigger. A fast upward follow would absorb a
    // gradually building cry into the "background" and never alert.
    const backgroundFollowRate = soundLevelDb < backgroundLevelDb ? 0.02 : (isLouderThanTrigger ? 0.0005 : 0.003);
    backgroundLevelDb = Math.max(-100, backgroundLevelDb + (soundLevelDb - backgroundLevelDb) * backgroundFollowRate);

    // While a parent's voice comes out of this device's speaker, the microphone hears it too, so it must not count.
    const isLoudVoiceLikeTick = !isParentVoiceBeingPlayed() &&
      soundLevelDb > alertThresholdDb && voiceBandShare > REQUIRED_VOICE_BAND_SHARE;
    recentSoundTicks.push(isLoudVoiceLikeTick ? 1 : 0);
    if (recentSoundTicks.length > SOUND_WINDOW_TICKS) recentSoundTicks.shift();
    if (sumOf(recentSoundTicks) >= LOUD_TICKS_REQUIRED_FOR_ALERT) sendAlert('sound');
  }

  // ---------------------------------------------------------------- movement detection
  function analyzeMovement() {
    const previewVideo = getElement('cameraPreview');
    if (!mediaStream || !mediaStream.getVideoTracks().length || previewVideo.readyState < 2) return;
    movementCanvasContext.drawImage(previewVideo, 0, 0, MOVEMENT_FRAME_WIDTH, MOVEMENT_FRAME_HEIGHT);
    const pixelData = movementCanvasContext.getImageData(0, 0, MOVEMENT_FRAME_WIDTH, MOVEMENT_FRAME_HEIGHT).data;
    const grayFrame = new Uint8Array(MOVEMENT_FRAME_WIDTH * MOVEMENT_FRAME_HEIGHT);
    for (let dataIndex = 0, pixelIndex = 0; dataIndex < pixelData.length; dataIndex += 4, pixelIndex++) {
      const red = pixelData[dataIndex], green = pixelData[dataIndex + 1], blue = pixelData[dataIndex + 2];
      grayFrame[pixelIndex] = (red * 77 + green * 150 + blue * 29) >> 8;
    }
    if (previousGrayFrame) {
      const changedPixels = new Uint8Array(grayFrame.length);   // 1 where the pixel changed since the last frame
      let changedPixelCount = 0;
      for (let pixelIndex = 0; pixelIndex < grayFrame.length; pixelIndex++) {
        if (Math.abs(grayFrame[pixelIndex] - previousGrayFrame[pixelIndex]) > PIXEL_CHANGE_THRESHOLD) {
          changedPixels[pixelIndex] = 1;
          changedPixelCount++;
        }
      }
      movementPercent = (changedPixelCount / grayFrame.length) * 100;   // % of the picture that changed
      updateMovementBox(findMovingArea(changedPixels));
    }
    previousGrayFrame = grayFrame;
    recentMovementTicks.push(movementPercent > MOVEMENT_PERCENT_THRESHOLD ? 1 : 0);
    if (recentMovementTicks.length > MOVEMENT_WINDOW_TICKS) recentMovementTicks.shift();
    const isCalibrated = calibrationTicksDone >= CALIBRATION_TICKS;
    const isMovementSustained = isCalibrated && sumOf(recentMovementTicks) >= MOVEMENT_TICKS_REQUIRED_FOR_ALERT;
    updateClipRecording(movementPercent > MOVEMENT_PERCENT_THRESHOLD, isMovementSustained);
    if (settings.movementAlertsEnabled && isMovementSustained) sendAlert('movement');
  }

  // ---------------------------------------------------------------- movement box
  // No AI model: this only finds WHERE the picture changed. It cannot tell a baby from a hand, a blanket
  // or a pet, and it cannot see someone lying perfectly still.
  // Returns the box around everything that moved, as { left, top, width, height } in fractions of the
  // picture, or null when nothing is moving. (When something moves slowly only its leading and trailing
  // edges change between two frames, so the box spans all the patches that changed, not just one.)
  function findMovingArea(changedPixels) {
    const cellWidth = MOVEMENT_FRAME_WIDTH / BOX_GRID_COLUMNS;
    const cellHeight = MOVEMENT_FRAME_HEIGHT / BOX_GRID_ROWS;
    const isCellMoving = [];
    for (let row = 0; row < BOX_GRID_ROWS; row++) {
      for (let column = 0; column < BOX_GRID_COLUMNS; column++) {
        let changedPixelsInCell = 0;
        for (let pixelRow = row * cellHeight; pixelRow < (row + 1) * cellHeight; pixelRow++) {
          for (let pixelColumn = column * cellWidth; pixelColumn < (column + 1) * cellWidth; pixelColumn++) {
            changedPixelsInCell += changedPixels[pixelRow * MOVEMENT_FRAME_WIDTH + pixelColumn];
          }
        }
        isCellMoving.push(changedPixelsInCell / (cellWidth * cellHeight) >= CELL_MOVING_PIXEL_SHARE);
      }
    }

    // Group moving cells that touch each other (diagonals count) and drop groups too small to be real movement.
    const isCellAlreadyGrouped = new Array(isCellMoving.length).fill(false);
    const significantGroups = [];
    for (let startCell = 0; startCell < isCellMoving.length; startCell++) {
      if (!isCellMoving[startCell] || isCellAlreadyGrouped[startCell]) continue;
      const group = { cellCount: 0, firstColumn: Infinity, lastColumn: -1, firstRow: Infinity, lastRow: -1 };
      const cellsToVisit = [startCell];
      isCellAlreadyGrouped[startCell] = true;
      while (cellsToVisit.length) {
        const cell = cellsToVisit.pop();
        const column = cell % BOX_GRID_COLUMNS;
        const row = Math.floor(cell / BOX_GRID_COLUMNS);
        group.cellCount++;
        group.firstColumn = Math.min(group.firstColumn, column);
        group.lastColumn = Math.max(group.lastColumn, column);
        group.firstRow = Math.min(group.firstRow, row);
        group.lastRow = Math.max(group.lastRow, row);
        for (let rowOffset = -1; rowOffset <= 1; rowOffset++) {
          for (let columnOffset = -1; columnOffset <= 1; columnOffset++) {
            const neighborRow = row + rowOffset;
            const neighborColumn = column + columnOffset;
            if (neighborRow < 0 || neighborRow >= BOX_GRID_ROWS) continue;
            if (neighborColumn < 0 || neighborColumn >= BOX_GRID_COLUMNS) continue;
            const neighborCell = neighborRow * BOX_GRID_COLUMNS + neighborColumn;
            if (isCellMoving[neighborCell] && !isCellAlreadyGrouped[neighborCell]) {
              isCellAlreadyGrouped[neighborCell] = true;
              cellsToVisit.push(neighborCell);
            }
          }
        }
      }
      if (group.cellCount >= MIN_CELLS_IN_MOVING_AREA) significantGroups.push(group);
    }

    if (significantGroups.length === 0) return null;
    const firstColumn = Math.min(...significantGroups.map((group) => group.firstColumn));
    const lastColumn = Math.max(...significantGroups.map((group) => group.lastColumn));
    const firstRow = Math.min(...significantGroups.map((group) => group.firstRow));
    const lastRow = Math.max(...significantGroups.map((group) => group.lastRow));
    return {
      left: firstColumn / BOX_GRID_COLUMNS,
      top: firstRow / BOX_GRID_ROWS,
      width: (lastColumn - firstColumn + 1) / BOX_GRID_COLUMNS,
      height: (lastRow - firstRow + 1) / BOX_GRID_ROWS,
    };
  }

  // Smooths the box so it glides instead of jumping, keeps it for a moment after movement stops,
  // shows it on this screen and tells the parents.
  function updateMovementBox(movingArea) {
    if (movingArea) {
      ticksWithoutMovement = 0;
      shownMovementBox = shownMovementBox ? {
        left: shownMovementBox.left + (movingArea.left - shownMovementBox.left) * BOX_SMOOTHING,
        top: shownMovementBox.top + (movingArea.top - shownMovementBox.top) * BOX_SMOOTHING,
        width: shownMovementBox.width + (movingArea.width - shownMovementBox.width) * BOX_SMOOTHING,
        height: shownMovementBox.height + (movingArea.height - shownMovementBox.height) * BOX_SMOOTHING,
      } : movingArea;
    } else if (shownMovementBox && ++ticksWithoutMovement > BOX_HOLD_TICKS) {
      shownMovementBox = null;
    }
    window.MonitorApp.showMovementBox(getElement('movementBox'), shownMovementBox);
    if ((shownMovementBox || wasBoxSentOnLastUpdate) && serverConnection) {
      serverConnection.sendMessage({ type: 'movement-box', box: shownMovementBox });
    }
    wasBoxSentOnLastUpdate = shownMovementBox !== null;
  }

  // ---------------------------------------------------------------- live view for the parent (WebRTC)
  async function startSendingLiveView(parentDeviceId, includeVideo) {
    stopSendingLiveView(parentDeviceId);
    // Same network: no STUN/TURN servers, so nothing leaves the home network.
    const peerConnection = new RTCPeerConnection({ iceServers: [] });
    liveViewConnections.set(parentDeviceId, peerConnection);
    pendingIceCandidates.set(parentDeviceId, []);
    mediaStream.getAudioTracks().forEach((track) => peerConnection.addTrack(track, mediaStream));
    if (includeVideo) mediaStream.getVideoTracks().forEach((track) => peerConnection.addTrack(track, mediaStream));
    if (talkConnections.has(parentDeviceId)) muteLiveViewAudioFor(parentDeviceId, true);   // this parent is talking right now
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        serverConnection.sendMessage({
          type: 'webrtc-signal', parentDeviceId, signal: { iceCandidate: event.candidate },
        });
      }
    };
    peerConnection.onconnectionstatechange = () => {
      const hasEnded = peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'closed';
      if (liveViewConnections.get(parentDeviceId) === peerConnection && hasEnded) stopSendingLiveView(parentDeviceId);
      showLiveViewStatus();
    };
    await peerConnection.setLocalDescription(await peerConnection.createOffer());
    serverConnection.sendMessage({
      type: 'webrtc-signal', parentDeviceId, signal: { sessionDescription: peerConnection.localDescription },
    });
    showLiveViewStatus();
  }

  async function handleWebRtcSignalFromParent(parentDeviceId, signal) {
    const peerConnection = liveViewConnections.get(parentDeviceId);
    if (!peerConnection || !signal) return;
    try {
      if (signal.sessionDescription) {
        await peerConnection.setRemoteDescription(signal.sessionDescription);
        for (const candidate of pendingIceCandidates.get(parentDeviceId).splice(0)) {
          await peerConnection.addIceCandidate(candidate).catch(() => {});
        }
      } else if (signal.iceCandidate) {
        if (peerConnection.remoteDescription) await peerConnection.addIceCandidate(signal.iceCandidate).catch(() => {});
        else pendingIceCandidates.get(parentDeviceId).push(signal.iceCandidate);
      }
    } catch { /* a failed handshake is retried by the parent */ }
  }

  function stopSendingLiveView(parentDeviceId) {
    const peerConnection = liveViewConnections.get(parentDeviceId);
    if (!peerConnection) return;
    liveViewConnections.delete(parentDeviceId);
    pendingIceCandidates.delete(parentDeviceId);
    peerConnection.onconnectionstatechange = null;
    peerConnection.onicecandidate = null;
    peerConnection.close();
    showLiveViewStatus();
  }

  // ---------------------------------------------------------------- the parent talks to the baby (WebRTC)
  // The parent opens the connection and sends its microphone; this device only plays it. Nothing is recorded.
  // Only one parent can talk at a time. While a parent talks, this device's microphone is not sent back to
  // that parent (they would hear themselves, and the two devices could squeal), and sound alerts are paused
  // (the microphone would hear the parent's own voice coming out of the speaker).
  async function handleTalkSignalFromParent(parentDeviceId, signal) {
    if (!signal || typeof parentDeviceId !== 'string') return;
    if (signal.sessionDescription) {
      await startReceivingTalk(parentDeviceId, signal.sessionDescription);
    } else if (signal.iceCandidate) {
      const peerConnection = talkConnections.get(parentDeviceId);
      if (!peerConnection) return;
      if (peerConnection.remoteDescription) {
        await peerConnection.addIceCandidate(signal.iceCandidate).catch(() => {});
      } else {
        const waitingCandidates = pendingTalkCandidates.get(parentDeviceId);
        if (waitingCandidates.length < MAX_WAITING_ICE_CANDIDATES) waitingCandidates.push(signal.iceCandidate);
      }
    }
  }

  async function startReceivingTalk(parentDeviceId, offer) {
    const isAnotherParentTalking = [...talkConnections.keys()].some((otherId) => otherId !== parentDeviceId);
    if (isAnotherParentTalking) {
      serverConnection.sendMessage({ type: 'talk-refused', parentDeviceId, reason: 'another-parent-is-talking' });
      return;
    }
    stopReceivingTalk(parentDeviceId);   // the same parent starting again replaces the old connection
    const peerConnection = new RTCPeerConnection({ iceServers: [] });
    talkConnections.set(parentDeviceId, peerConnection);
    pendingTalkCandidates.set(parentDeviceId, []);
    muteLiveViewAudioFor(parentDeviceId, true);
    peerConnection.ontrack = (event) => playParentVoice(event.streams[0] || new MediaStream([event.track]));
    peerConnection.onicecandidate = (event) => {
      if (event.candidate && serverConnection) {
        serverConnection.sendMessage({
          type: 'talk-signal', parentDeviceId, signal: { iceCandidate: event.candidate },
        });
      }
    };
    peerConnection.onconnectionstatechange = () => {
      const hasEnded = peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'closed';
      if (talkConnections.get(parentDeviceId) === peerConnection && hasEnded) stopReceivingTalk(parentDeviceId);
      showParentVoiceStatus();
    };
    showParentVoiceStatus();
    try {
      await peerConnection.setRemoteDescription(offer);
      if (talkConnections.get(parentDeviceId) !== peerConnection) return;   // stopped while connecting
      for (const candidate of pendingTalkCandidates.get(parentDeviceId).splice(0)) {
        await peerConnection.addIceCandidate(candidate).catch(() => {});
      }
      await peerConnection.setLocalDescription(await peerConnection.createAnswer());
      if (talkConnections.get(parentDeviceId) !== peerConnection || !serverConnection) return;
      serverConnection.sendMessage({
        type: 'talk-signal', parentDeviceId, signal: { sessionDescription: peerConnection.localDescription },
      });
    } catch {
      if (talkConnections.get(parentDeviceId) === peerConnection) stopReceivingTalk(parentDeviceId);
    }
  }

  function stopReceivingTalk(parentDeviceId) {
    const peerConnection = talkConnections.get(parentDeviceId);
    if (!peerConnection) return;
    talkConnections.delete(parentDeviceId);
    pendingTalkCandidates.delete(parentDeviceId);
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
    talkAlertPauseEndTime = Date.now() + ALERT_PAUSE_AFTER_TALK_MILLISECONDS;
    muteLiveViewAudioFor(parentDeviceId, false);
    if (talkConnections.size === 0) {
      getElement('parentVoiceAudio').srcObject = null;
      getElement('enableVoiceButton').hidden = true;
    }
    showParentVoiceStatus();
  }

  // Stops (or restores) this device's microphone in the live view sent to ONE parent. The other parents are not affected.
  function muteLiveViewAudioFor(parentDeviceId, shouldMute) {
    const peerConnection = liveViewConnections.get(parentDeviceId);
    if (!peerConnection) return;
    const microphoneTrack = mediaStream ? mediaStream.getAudioTracks()[0] : null;
    peerConnection.getTransceivers()
      .filter((transceiver) => transceiver.receiver.track.kind === 'audio')
      .forEach((transceiver) => transceiver.sender.replaceTrack(shouldMute ? null : microphoneTrack).catch(() => {}));
  }

  function playParentVoice(voiceStream) {
    const voiceAudio = getElement('parentVoiceAudio');
    voiceAudio.srcObject = voiceStream;
    // Some phones refuse to play sound until the screen is tapped; show a button in that case.
    voiceAudio.play().then(
      () => { getElement('enableVoiceButton').hidden = true; },
      () => { getElement('enableVoiceButton').hidden = false; },
    );
  }

  function isParentVoiceBeingPlayed() {
    return talkConnections.size > 0 || Date.now() < talkAlertPauseEndTime;
  }

  getElement('enableVoiceButton').addEventListener('click', () => {
    getElement('parentVoiceAudio').play().then(() => { getElement('enableVoiceButton').hidden = true; }, () => {});
  });

  // ---------------------------------------------------------------- movement clips
  // Only when "Save a short clip when movement is detected" is switched on. A clip runs from 10 s BEFORE the
  // first sign of movement to 20 s after the last one, and is KEPT only if the movement turns out to be
  // sustained (the same test as the movement alert); otherwise it is thrown away. To have the 10 s "before",
  // two recorders run in turn while this is switched on, and everything they record is dropped after 20 s
  // unless it becomes part of a clip. Clips live in this page's memory only: this app never writes them to a
  // file, and they are gone when monitoring stops or the page closes. Parents fetch them directly from this
  // device (WebRTC data channel), never through the server.
  function startRollingRecording() {
    if (typeof MediaRecorder === 'undefined' || !mediaStream || mediaStream.getVideoTracks().length === 0) return;
    const supportedMimeType = CLIP_MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
    let recorder;
    try {
      recorder = new MediaRecorder(mediaStream, Object.assign(
        { videoBitsPerSecond: CLIP_VIDEO_BITS_PER_SECOND, audioBitsPerSecond: CLIP_AUDIO_BITS_PER_SECOND },
        supportedMimeType ? { mimeType: supportedMimeType } : {},
      ));
    } catch { return; }
    const recording = {
      recorder, chunks: [], startedAt: Date.now(), shouldDiscard: false, onFinished: null,
      mimeType: supportedMimeType || 'video/webm',
    };
    recorder.ondataavailable = (event) => { if (event.data && event.data.size) recording.chunks.push(event.data); };
    recorder.onerror = () => { recording.shouldDiscard = true; };
    recorder.onstop = () => {
      if (recording.onFinished && !recording.shouldDiscard) recording.onFinished(recording);
      recording.chunks.length = 0;   // free the memory (a saved clip has already copied the pieces into its own blob)
    };
    try {
      recorder.start(1000);
    } catch { return; }
    rollingRecordings.push(recording);
  }

  function discardRecording(recording) {
    recording.shouldDiscard = true;
    try {
      if (recording.recorder.state !== 'inactive') recording.recorder.stop();
    } catch { /* already stopped */ }
    recording.chunks.length = 0;
  }

  // Runs every second: ends a finished clip, drops recordings older than 20 s and starts a new one when the
  // newest waiting recording is 10 s old, so one is always 10-20 s old when movement starts.
  function keepRollingRecordingsFresh() {
    if (!settings.recordClipsEnabled || !mediaStream) return;
    const now = Date.now();
    if (activeClip) {
      const clipEndTime = Math.min(
        activeClip.lastMovementAt + CLIP_SECONDS_AFTER_MOVEMENT * 1000,
        activeClip.firstMovementAt + MAX_CLIP_SECONDS_AFTER_FIRST_MOVEMENT * 1000,
      );
      if (now >= clipEndTime) finishActiveClip();
    }
    rollingRecordings = rollingRecordings.filter((recording) => {
      const isTooOld = now - recording.startedAt >= ROLLING_RECORDER_LIFETIME_MILLISECONDS;
      if (isTooOld) discardRecording(recording);
      return !isTooOld;
    });
    const hasRecentWaitingRecording = rollingRecordings.some(
      (recording) => now - recording.startedAt < ROLLING_RECORDER_START_GAP_MILLISECONDS);
    if (!hasRecentWaitingRecording) startRollingRecording();
    showSavedClipsStatus();
  }

  function updateClipRecording(isMovingNow, isMovementSustained) {
    if (!settings.recordClipsEnabled || !mediaStream) return;
    if (activeClip) {
      if (isMovingNow) activeClip.lastMovementAt = Date.now();
      if (isMovementSustained) activeClip.hasSustainedMovement = true;
      return;
    }
    if (!isMovingNow || rollingRecordings.length === 0) return;
    const oldestRecording = rollingRecordings[0];   // started first, so it has the most "before" in it
    rollingRecordings.shift();                      // it leaves the rolling set; a new one is started within a second
    const now = Date.now();
    activeClip = { recording: oldestRecording, firstMovementAt: now, lastMovementAt: now, hasSustainedMovement: isMovementSustained };
    showSavedClipsStatus();
  }

  function finishActiveClip() {
    if (!activeClip) return;
    const { recording, firstMovementAt, hasSustainedMovement } = activeClip;
    activeClip = null;
    if (!hasSustainedMovement) { discardRecording(recording); showSavedClipsStatus(); return; }
    recording.onFinished = (finishedRecording) => {
      if (!finishedRecording.chunks.length) return;
      saveClip({
        id: 'clip-' + (++clipCounter),
        startedAt: finishedRecording.startedAt,
        movementAt: firstMovementAt,
        durationSeconds: Math.max(1, Math.round((Date.now() - finishedRecording.startedAt) / 1000)),
        blob: new Blob(finishedRecording.chunks, { type: finishedRecording.recorder.mimeType || finishedRecording.mimeType }),
      });
      showSavedClipsStatus();
    };
    try {
      if (recording.recorder.state !== 'inactive') recording.recorder.stop();
    } catch { discardRecording(recording); }
    showSavedClipsStatus();
  }

  function discardAllRecordings() {
    if (activeClip) { discardRecording(activeClip.recording); activeClip = null; }
    rollingRecordings.forEach(discardRecording);
    rollingRecordings = [];
  }

  function saveClip(clip) {
    savedClips.push(clip);
    const totalBytes = () => sumOf(savedClips.map((savedClip) => savedClip.blob.size));
    while (savedClips.length > MAX_SAVED_CLIPS || (savedClips.length > 1 && totalBytes() > MAX_SAVED_CLIP_BYTES)) {
      savedClips.shift();
    }
    sendClipListToAllParents();
  }

  function removeAllClips() {
    discardAllRecordings();          // the waiting "10 s before" recordings go too
    savedClips.length = 0;
    sendClipListToAllParents();
    showSavedClipsStatus();
  }

  // The Delete buttons: everything is wiped, then a fresh "10 s before" recording starts if clips are still on.
  function deleteAllClips() {
    removeAllClips();
    keepRollingRecordingsFresh();
  }

  function applyRecordClipsSetting(isEnabled) {
    settings.recordClipsEnabled = isEnabled;
    if (isEnabled) keepRollingRecordingsFresh();
    else discardAllRecordings();     // switching it off throws away everything not yet saved
    showSavedClipsStatus();
  }

  const describeClip = (clip) => ({
    id: clip.id, startedAt: clip.startedAt, movementAt: clip.movementAt, durationSeconds: clip.durationSeconds,
    sizeBytes: clip.blob.size,
  });

  function sendClipList(channel) {
    if (!channel || channel.readyState !== 'open') return;
    channel.send(JSON.stringify({ type: 'list', clips: savedClips.map(describeClip) }));
  }

  function sendClipListToAllParents() {
    clipConnections.forEach((connection) => sendClipList(connection.channel));
  }

  // A parent opens a data channel to this device and asks for the list, or for one clip.
  async function handleClipSignalFromParent(parentDeviceId, signal) {
    if (!signal || typeof parentDeviceId !== 'string') return;
    if (signal.sessionDescription) {
      await startClipConnection(parentDeviceId, signal.sessionDescription);
    } else if (signal.iceCandidate) {
      const connection = clipConnections.get(parentDeviceId);
      if (!connection) return;
      if (connection.peerConnection.remoteDescription) {
        await connection.peerConnection.addIceCandidate(signal.iceCandidate).catch(() => {});
      } else {
        const waitingCandidates = pendingClipCandidates.get(parentDeviceId);
        if (waitingCandidates.length < MAX_WAITING_ICE_CANDIDATES) waitingCandidates.push(signal.iceCandidate);
      }
    }
  }

  async function startClipConnection(parentDeviceId, offer) {
    stopClipConnection(parentDeviceId);   // the same parent connecting again replaces its old connection
    const peerConnection = new RTCPeerConnection({ iceServers: [] });
    const connection = { peerConnection, channel: null, isSending: false };
    clipConnections.set(parentDeviceId, connection);
    pendingClipCandidates.set(parentDeviceId, []);
    peerConnection.ondatachannel = (event) => {
      connection.channel = event.channel;
      event.channel.binaryType = 'arraybuffer';
      event.channel.bufferedAmountLowThreshold = CLIP_CHANNEL_BUFFER_LIMIT_BYTES / 4;
      event.channel.onmessage = (messageEvent) => handleClipRequest(connection, messageEvent.data);
    };
    peerConnection.onicecandidate = (event) => {
      if (event.candidate && serverConnection) {
        serverConnection.sendMessage({
          type: 'clip-signal', parentDeviceId, signal: { iceCandidate: event.candidate },
        });
      }
    };
    peerConnection.onconnectionstatechange = () => {
      const hasEnded = peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'closed';
      if (clipConnections.get(parentDeviceId) === connection && hasEnded) stopClipConnection(parentDeviceId);
    };
    try {
      await peerConnection.setRemoteDescription(offer);
      if (clipConnections.get(parentDeviceId) !== connection) return;   // replaced while connecting
      for (const candidate of pendingClipCandidates.get(parentDeviceId).splice(0)) {
        await peerConnection.addIceCandidate(candidate).catch(() => {});
      }
      await peerConnection.setLocalDescription(await peerConnection.createAnswer());
      if (clipConnections.get(parentDeviceId) !== connection || !serverConnection) return;
      serverConnection.sendMessage({
        type: 'clip-signal', parentDeviceId, signal: { sessionDescription: peerConnection.localDescription },
      });
    } catch {
      if (clipConnections.get(parentDeviceId) === connection) stopClipConnection(parentDeviceId);
    }
  }

  function stopClipConnection(parentDeviceId) {
    const connection = clipConnections.get(parentDeviceId);
    if (!connection) return;
    clipConnections.delete(parentDeviceId);
    pendingClipCandidates.delete(parentDeviceId);
    connection.peerConnection.ondatachannel = null;
    connection.peerConnection.onicecandidate = null;
    connection.peerConnection.onconnectionstatechange = null;
    connection.peerConnection.close();
  }

  function handleClipRequest(connection, rawRequest) {
    let request;
    try { request = JSON.parse(rawRequest); } catch { return; }
    if (!request || typeof request.type !== 'string') return;
    if (request.type === 'list') sendClipList(connection.channel);
    else if (request.type === 'get') sendClip(connection, request.id);
    else if (request.type === 'delete-all') deleteAllClips();
  }

  // Sends one clip as small binary pieces, pausing whenever the channel's send buffer is full.
  async function sendClip(connection, clipId) {
    const channel = connection.channel;
    if (!channel || channel.readyState !== 'open' || connection.isSending) return;
    const clip = savedClips.find((savedClip) => savedClip.id === clipId);
    if (!clip) { channel.send(JSON.stringify({ type: 'clip-missing', id: String(clipId) })); return; }
    connection.isSending = true;
    try {
      const clipBytes = await clip.blob.arrayBuffer();
      channel.send(JSON.stringify({ type: 'clip-start', id: clip.id, mimeType: clip.blob.type, sizeBytes: clipBytes.byteLength }));
      for (let offset = 0; offset < clipBytes.byteLength; offset += CLIP_CHUNK_BYTES) {
        while (channel.bufferedAmount > CLIP_CHANNEL_BUFFER_LIMIT_BYTES) {
          if (channel.readyState !== 'open') return;
          await new Promise((resolve) => { channel.onbufferedamountlow = resolve; });
        }
        if (channel.readyState !== 'open') return;
        channel.send(clipBytes.slice(offset, offset + CLIP_CHUNK_BYTES));
      }
      channel.send(JSON.stringify({ type: 'clip-end', id: clip.id }));
    } catch { /* the channel closed part-way; the parent can ask again */ } finally {
      connection.isSending = false;
    }
  }

  // ---------------------------------------------------------------- what is shown on screen
  function showSavedClipsStatus() {
    const savedText = savedClips.length + ' saved';
    getElement('savedClipsStatus').textContent = activeClip ? 'recording… (' + savedText + ')'
      : settings.recordClipsEnabled ? 'on · ' + savedText
        : savedClips.length ? 'off · ' + savedText : 'off';
  }

  function showParentVoiceStatus() {
    const connections = [...talkConnections.values()];
    getElement('parentVoiceStatus').textContent =
      connections.some((connection) => connection.connectionState === 'connected') ? 'parent is talking'
        : connections.length ? 'connecting…' : 'idle';
  }

  function showLiveViewStatus() {
    const connectedViewerCount =
      [...liveViewConnections.values()].filter((connection) => connection.connectionState === 'connected').length;
    getElement('liveViewStatus').textContent = connectedViewerCount
      ? 'sending to ' + connectedViewerCount + ' device' + (connectedViewerCount > 1 ? 's' : '')
      : 'no';
  }

  function showLevels() {
    const toPercentWidth = (fraction) => clamp(fraction, 0, 1) * 100 + '%';
    getElement('soundLevelText').textContent = calibrationTicksDone < CALIBRATION_TICKS
      ? 'calibrating - stay quiet…'
      : Math.round(soundLevelDb) + ' dB (alert above ' + Math.round(alertThresholdDb) + ')';
    getElement('soundLevelBar').style.width = toPercentWidth((soundLevelDb + 90) / 90);
    getElement('soundThresholdMark').style.left = toPercentWidth((alertThresholdDb + 90) / 90);
    getElement('movementText').textContent = movementPercent.toFixed(1) + '%';
    getElement('movementBar').style.width = toPercentWidth(movementPercent / 20);
  }

  function showSettings() {
    getElement('soundSensitivity').value = settings.soundSensitivity;
    getElement('soundSensitivityValue').textContent = settings.soundSensitivity;
    getElement('movementAlertsCheckbox').checked = settings.movementAlertsEnabled;
    getElement('recordClipsCheckbox').checked = settings.recordClipsEnabled;
    showSavedClipsStatus();
  }

  function saveSettings() {
    deviceStorage.write('soundSensitivity', settings.soundSensitivity);
    deviceStorage.write('movementAlertsEnabled', settings.movementAlertsEnabled ? '1' : '0');
    deviceStorage.write('recordClipsEnabled', settings.recordClipsEnabled ? '1' : '0');
  }

  getElement('soundSensitivity').addEventListener('input', () => {
    settings.soundSensitivity = +getElement('soundSensitivity').value;
    saveSettings();
    showSettings();
  });
  getElement('movementAlertsCheckbox').addEventListener('change', () => {
    settings.movementAlertsEnabled = getElement('movementAlertsCheckbox').checked;
    saveSettings();
  });
  getElement('recordClipsCheckbox').addEventListener('change', () => {
    applyRecordClipsSetting(getElement('recordClipsCheckbox').checked);
    saveSettings();
  });
  getElement('deleteClipsButton').addEventListener('click', deleteAllClips);

  // Screen dimming (black overlay) saves battery and stops the screen lighting up the room.
  function scheduleScreenDimming() {
    clearTimeout(dimScreenTimer);
    dimScreenTimer = setTimeout(dimScreen, SCREEN_DIM_DELAY_MILLISECONDS);
  }
  function dimScreen() { getElement('dimOverlay').hidden = false; }
  getElement('liveSection').addEventListener('pointerdown', scheduleScreenDimming);
  getElement('dimOverlay').addEventListener('pointerdown', () => {
    getElement('dimOverlay').hidden = true;
    scheduleScreenDimming();
  });
})();
