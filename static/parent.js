// Parent unit: shows status, sounds the alarm, and (on request) plays live audio/video from the baby unit.
(() => {
  'use strict';
  const getElement = (id) => document.getElementById(id);

  // [title, explanation] for each kind of alarm
  const ALARM_MESSAGES = {
    sound: ['Baby is making noise', 'Sound detected, possibly crying.'],
    movement: ['Movement', 'Movement detected in the cot.'],
    offline: ['Baby unit offline', 'No signal from the baby unit. Check that it is on, charged and on Wi-Fi.'],
    connectionLost: ['Connection lost', 'This device lost its connection to the monitor, so alerts cannot reach you.'],
    babyUnitFault: ['Baby unit problem', 'The baby unit microphone stopped working.'],
    test: ['Test alarm', 'This is only a test. If you can hear and see this, alerts will work.'],
  };

  const BABY_UNIT_SILENCE_LIMIT_MILLISECONDS = 8000;       // no status for this long = baby unit has gone silent
  const SILENT_BABY_UNIT_ALARM_REPEAT_MILLISECONDS = 5000;
  const CONNECTION_LOST_ALARM_DELAY_MILLISECONDS = 10000;
  const ALARM_SOUND_REPEAT_MILLISECONDS = 1500;
  const PAUSE_AFTER_DISMISSING_NOISE_ALARM_MILLISECONDS = 30000;
  const PAUSE_AFTER_DISMISSING_OTHER_ALARM_MILLISECONDS = 60000;
  const SNOOZE_DURATION_MILLISECONDS = 10 * 60 * 1000;
  const SETTINGS_SEND_DELAY_MILLISECONDS = 300;            // wait for the slider to settle before sending
  const TALK_AUTO_STOP_MILLISECONDS = 2 * 60 * 1000;       // the microphone never stays on by accident
  const CLIP_RECONNECT_DELAY_MILLISECONDS = 3000;
  const MAX_WAITING_ICE_CANDIDATES = 50;

  const DEFAULT_TALK_MESSAGE = 'Your voice plays on the baby unit while you talk. The microphone is only on while you talk.';
  const TALK_REFUSAL_MESSAGES = {
    'another-parent-is-talking': 'Another parent is talking to the baby right now. Try again in a moment.',
  };

  let serverConnection = null, audioContext = null;
  let liveViewConnection = null, pendingIceCandidates = [], requestedLiveView = null;
  let hasJoined = false, wasJoinDenied = false, isBabyUnitOnline = false, hasBabyUnitEverConnected = false;
  let isBabyUnitSilent = false, isBabyMicrophoneFaulty = false;
  let lastStatusTimestamp = 0, connectionLostTimer = null, activeAlarmKind = null;
  let alarmSoundTimer = null, settingsSendTimer = null;
  let isTalking = false, talkConnection = null, talkMicrophoneStream = null, talkAutoStopTimer = null;
  let pendingTalkCandidates = [];
  let clipConnection = null, clipChannel = null, clipRetryTimer = null, pendingClipCandidates = [];
  let incomingClip = null, loadingClipId = null, availableClips = [], shownClipUrl = null;
  const pausedUntilByAlarmKind = {};
  const originalPageTitle = document.title;

  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
  const isNoiseOrMovementAlarm = (alarmKind) => alarmKind === 'sound' || alarmKind === 'movement';
  const showSetupError = (message) => { getElement('setupError').textContent = message; };
  getElement('connectButton').addEventListener('click', connectToMonitor);

  // ---------------------------------------------------------------- connect
  function connectToMonitor() {
    const pin = getElement('pin').value.trim();
    if (!pin) return showSetupError('Enter the PIN shown on the computer running the server.');
    showSetupError('');
    wasJoinDenied = false;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!audioContext) audioContext = new AudioContextClass();   // created on a tap so the alarm is allowed to play
    audioContext.resume().catch(() => {});
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    window.MonitorApp.keepScreenAwake();
    serverConnection = window.MonitorApp.createServerConnection('parent', pin, {
      onConnectionStateChange: handleConnectionStateChange,
      onJoinDenied: handleJoinDenied,
      onServerMessage: handleServerMessage,
    });
    serverConnection.connect();
  }

  function handleJoinDenied(reason) {
    wasJoinDenied = true;
    showSetupError(reason === 'locked' ? 'Too many wrong PINs. Wait 5 minutes and try again.' : 'Wrong PIN.');
    getElement('liveSection').hidden = true;
    getElement('setupSection').hidden = false;
  }

  function handleConnectionStateChange(state) {
    if (wasJoinDenied) return;
    const badge = getElement('connectionBadge');
    badge.textContent = state === 'online' ? 'connected' : 'reconnecting…';
    badge.className = 'pill ' + (state === 'online' ? 'ok' : 'bad');
    if (state !== 'online') {   // the server forgets this device when the link drops
      stopTalking(false);
      closeClipConnection();
      showClipMessage('Reconnecting…');
    }
    if (state === 'online') {
      clearTimeout(connectionLostTimer);
      connectionLostTimer = null;
      if (activeAlarmKind === 'connectionLost') stopAlarm();
    } else if (hasJoined && !connectionLostTimer) {
      // We can't receive alerts any more, so tell the parent.
      connectionLostTimer = setTimeout(() => triggerAlarm('connectionLost'), CONNECTION_LOST_ALARM_DELAY_MILLISECONDS);
      showBabyUnitConnection('unknown');
    }
  }

  function handleServerMessage(message) {
    switch (message.type) {
      case 'joined':
        hasJoined = true;
        getElement('setupSection').hidden = true;
        getElement('liveSection').hidden = false;
        isBabyUnitOnline = !!message.isBabyUnitOnline;
        if (isBabyUnitOnline) { hasBabyUnitEverConnected = true; lastStatusTimestamp = Date.now(); }
        showBabyUnitConnection();
        if (requestedLiveView && isBabyUnitOnline) startReceivingLiveView(requestedLiveView.includeVideo);
        if (isBabyUnitOnline) connectToClips();
        break;
      case 'baby-online':
        isBabyUnitOnline = true;
        hasBabyUnitEverConnected = true;
        isBabyUnitSilent = false;
        lastStatusTimestamp = Date.now();
        if (activeAlarmKind === 'offline') stopAlarm();
        showBabyUnitConnection();
        if (requestedLiveView) startReceivingLiveView(requestedLiveView.includeVideo);
        connectToClips();
        break;
      case 'baby-offline':
        isBabyUnitOnline = false;
        stopReceivingLiveView();
        stopTalking(false);
        closeClipConnection();
        showClipMessage('The baby unit is offline. Clips will be listed again when it is back.');
        showBabyUnitConnection();
        if (hasBabyUnitEverConnected) triggerAlarm('offline');
        break;
      case 'status': showBabyUnitStatus(message); break;
      case 'movement-box': window.MonitorApp.showMovementBox(getElement('movementBox'), message.box); break;
      case 'alert': triggerAlarm(message.alertKind); break;
      case 'webrtc-signal': handleWebRtcSignalFromBabyUnit(message.signal); break;
      case 'talk-signal': handleTalkSignalFromBabyUnit(message.signal); break;
      case 'clip-signal': handleClipSignalFromBabyUnit(message.signal); break;
      case 'talk-refused': handleTalkRefused(message.reason); break;
      case 'alarm-dismissed': dismissAlarm(false); break;
      default: break;
    }
  }

  // ---------------------------------------------------------------- baby unit status
  function showBabyUnitStatus(status) {
    lastStatusTimestamp = Date.now();
    if (isBabyUnitSilent) {
      isBabyUnitSilent = false;
      if (activeAlarmKind === 'offline') stopAlarm();
      showBabyUnitConnection();
    }
    getElement('soundLevelText').textContent = status.isCalibrating ? 'calibrating…' : status.soundLevelDb + ' dB';
    const toPercentWidth = (fraction) => clamp(fraction, 0, 1) * 100 + '%';
    getElement('soundLevelBar').style.width = toPercentWidth((status.soundLevelDb + 90) / 90);
    getElement('soundThresholdMark').style.left = toPercentWidth((status.alertThresholdDb + 90) / 90);
    getElement('movementText').textContent = status.movementPercent.toFixed(1) + '%';
    getElement('movementBar').style.width = toPercentWidth(status.movementPercent / 20);

    const sensitivitySlider = getElement('soundSensitivity');
    const movementCheckbox = getElement('movementAlertsCheckbox');
    if (document.activeElement !== sensitivitySlider) sensitivitySlider.value = status.soundSensitivity;
    getElement('soundSensitivityValue').textContent = sensitivitySlider.value;
    if (document.activeElement !== movementCheckbox) movementCheckbox.checked = status.movementAlertsEnabled;
    const recordClipsCheckbox = getElement('recordClipsCheckbox');
    if (document.activeElement !== recordClipsCheckbox) recordClipsCheckbox.checked = !!status.recordClipsEnabled;

    if (status.isMicrophoneWorking === false) {
      if (!isBabyMicrophoneFaulty) { isBabyMicrophoneFaulty = true; triggerAlarm('babyUnitFault'); }
    } else if (isBabyMicrophoneFaulty) {
      isBabyMicrophoneFaulty = false;
      if (activeAlarmKind === 'babyUnitFault') stopAlarm();
    }
  }

  function showBabyUnitConnection(forcedState) {
    const badge = getElement('babyUnitBadge');
    let badgeText, badgeClass;
    if (forcedState === 'unknown') { badgeText = 'unknown'; badgeClass = 'pill bad'; }
    else if (!isBabyUnitOnline) {
      badgeText = hasBabyUnitEverConnected ? 'OFFLINE' : 'not connected yet';
      badgeClass = 'pill bad';
    }
    else if (isBabyUnitSilent) { badgeText = 'NO SIGNAL'; badgeClass = 'pill bad'; }
    else { badgeText = 'online'; badgeClass = 'pill ok'; }
    badge.textContent = badgeText;
    badge.className = badgeClass;
  }

  // Watchdog: if the baby unit goes silent (battery died, Wi-Fi dropped, tab frozen), say so.
  setInterval(() => {
    if (!hasJoined || !isBabyUnitOnline || isBabyUnitSilent) return;
    if (Date.now() - lastStatusTimestamp > BABY_UNIT_SILENCE_LIMIT_MILLISECONDS) {
      isBabyUnitSilent = true;
      showBabyUnitConnection();
      triggerAlarm('offline');
    }
  }, 1000);
  setInterval(() => {
    if (isBabyUnitSilent && isBabyUnitOnline) triggerAlarm('offline');
  }, SILENT_BABY_UNIT_ALARM_REPEAT_MILLISECONDS);

  // ---------------------------------------------------------------- alarm
  function triggerAlarm(alarmKind) {
    if (!ALARM_MESSAGES[alarmKind]) return;
    if (Date.now() < (pausedUntilByAlarmKind[alarmKind] || 0)) return;
    const [title, explanation] = ALARM_MESSAGES[alarmKind];
    const isNewAlarmKind = activeAlarmKind !== alarmKind;
    activeAlarmKind = alarmKind;
    getElement('alarmTitle').textContent = title;
    getElement('alarmText').textContent = explanation + ' (' + new Date().toLocaleTimeString() + ')';
    getElement('snoozeButton').hidden = !isNoiseOrMovementAlarm(alarmKind);
    getElement('alarmOverlay').hidden = false;
    if (isNoiseOrMovementAlarm(alarmKind)) {
      getElement('lastAlertText').textContent = alarmKind + ' at ' + new Date().toLocaleTimeString();
    }
    document.title = '⚠ ' + title;
    if (!alarmSoundTimer) {
      playAlarmSound();
      alarmSoundTimer = setInterval(playAlarmSound, ALARM_SOUND_REPEAT_MILLISECONDS);
    }
    try {
      if (isNewAlarmKind && 'Notification' in window && Notification.permission === 'granted') {
        new Notification('Baby monitor: ' + title, { body: explanation, tag: 'babymon', requireInteraction: true });
      }
    } catch { /* notifications not allowed on this browser */ }
  }

  function playAlarmSound() {
    if (navigator.vibrate) navigator.vibrate([400, 150, 400]);
    if (!audioContext) return;
    audioContext.resume().catch(() => {});
    const now = audioContext.currentTime;
    [880, 660, 880].forEach((frequencyHz, beepNumber) => {
      const oscillator = audioContext.createOscillator();
      const volumeControl = audioContext.createGain();
      const beepStartTime = now + beepNumber * 0.25;
      oscillator.type = 'square';
      oscillator.frequency.value = frequencyHz;
      volumeControl.gain.setValueAtTime(0.0001, beepStartTime);
      volumeControl.gain.exponentialRampToValueAtTime(0.5, beepStartTime + 0.02);
      volumeControl.gain.exponentialRampToValueAtTime(0.0001, beepStartTime + 0.22);
      oscillator.connect(volumeControl).connect(audioContext.destination);
      oscillator.start(beepStartTime);
      oscillator.stop(beepStartTime + 0.25);
    });
  }

  function stopAlarm() {
    activeAlarmKind = null;
    clearInterval(alarmSoundTimer);
    alarmSoundTimer = null;
    getElement('alarmOverlay').hidden = true;
    document.title = originalPageTitle;
  }

  function dismissAlarm(shouldTellOtherParents) {
    if (!activeAlarmKind) return;
    const dismissedAlarmKind = activeAlarmKind;
    pausedUntilByAlarmKind[dismissedAlarmKind] = Date.now() + (isNoiseOrMovementAlarm(dismissedAlarmKind)
      ? PAUSE_AFTER_DISMISSING_NOISE_ALARM_MILLISECONDS
      : PAUSE_AFTER_DISMISSING_OTHER_ALARM_MILLISECONDS);
    stopAlarm();
    if (shouldTellOtherParents && serverConnection) serverConnection.sendMessage({ type: 'dismiss-alarm' });
  }

  function pauseNoiseAndMovementAlarmsUntil(pauseEndTime) {
    pausedUntilByAlarmKind.sound = pauseEndTime;
    pausedUntilByAlarmKind.movement = pauseEndTime;
  }

  getElement('dismissButton').addEventListener('click', () => dismissAlarm(true));
  getElement('snoozeButton').addEventListener('click', () => {
    const snoozeEndTime = Date.now() + SNOOZE_DURATION_MILLISECONDS;
    dismissAlarm(true);
    pauseNoiseAndMovementAlarmsUntil(snoozeEndTime);   // dismissAlarm() applied a short pause; extend it
    getElement('snoozeEndText').textContent =
      new Date(snoozeEndTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    getElement('snoozeNotice').hidden = false;
    setTimeout(() => {
      if (Date.now() >= snoozeEndTime) getElement('snoozeNotice').hidden = true;
    }, SNOOZE_DURATION_MILLISECONDS + 500);
  });
  getElement('resumeAlertsButton').addEventListener('click', () => {
    pauseNoiseAndMovementAlarmsUntil(0);
    getElement('snoozeNotice').hidden = true;
  });
  getElement('testAlarmButton').addEventListener('click', () => {
    pausedUntilByAlarmKind.test = 0;
    triggerAlarm('test');
  });

  // ---------------------------------------------------------------- listen / watch live (WebRTC)
  function showLiveViewMessage(message) { getElement('liveViewMessage').textContent = message; }

  function startReceivingLiveView(includeVideo) {
    stopReceivingLiveView();
    requestedLiveView = { includeVideo };
    if (!isBabyUnitOnline) { showLiveViewMessage('Waiting for the baby unit…'); return; }
    // Same network: no STUN/TURN servers, so nothing goes via the internet.
    const thisConnection = new RTCPeerConnection({ iceServers: [] });
    liveViewConnection = thisConnection;
    pendingIceCandidates = [];
    thisConnection.ontrack = (event) => {
      const liveMedia = getElement('liveMedia');
      liveMedia.srcObject = event.streams[0] || new MediaStream([event.track]);
      liveMedia.play().catch(() => {});
      if (event.track.kind === 'video') getElement('videoContainer').hidden = false;
    };
    thisConnection.onicecandidate = (event) => {
      if (event.candidate && serverConnection) {
        serverConnection.sendMessage({ type: 'webrtc-signal', signal: { iceCandidate: event.candidate } });
      }
    };
    thisConnection.onconnectionstatechange = () => {
      if (liveViewConnection !== thisConnection) return;
      const connectionState = thisConnection.connectionState;
      if (connectionState === 'connected') {
        showLiveViewMessage(requestedLiveView && requestedLiveView.includeVideo ? 'Watching live.' : 'Listening live.');
      } else if (connectionState === 'failed') {
        showLiveViewMessage('Stream failed, retrying…');
        setTimeout(() => {
          if (liveViewConnection === thisConnection && requestedLiveView) {
            startReceivingLiveView(requestedLiveView.includeVideo);
          }
        }, 2000);
      } else {
        showLiveViewMessage('Connecting…');
      }
    };
    showLiveViewMessage('Connecting…');
    serverConnection.sendMessage({ type: 'start-live-view', includeVideo });
  }

  async function handleWebRtcSignalFromBabyUnit(signal) {
    const thisConnection = liveViewConnection;
    if (!thisConnection || !signal) return;
    try {
      if (signal.sessionDescription) {
        await thisConnection.setRemoteDescription(signal.sessionDescription);
        for (const candidate of pendingIceCandidates.splice(0)) {
          await thisConnection.addIceCandidate(candidate).catch(() => {});
        }
        await thisConnection.setLocalDescription(await thisConnection.createAnswer());
        serverConnection.sendMessage({
          type: 'webrtc-signal', signal: { sessionDescription: thisConnection.localDescription },
        });
      } else if (signal.iceCandidate) {
        if (thisConnection.remoteDescription) {
          await thisConnection.addIceCandidate(signal.iceCandidate).catch(() => {});
        } else {
          pendingIceCandidates.push(signal.iceCandidate);
        }
      }
    } catch { showLiveViewMessage('Stream error. Tap Listen or Watch to retry.'); }
  }

  function stopReceivingLiveView() {
    if (liveViewConnection) {
      liveViewConnection.onconnectionstatechange = null;
      liveViewConnection.onicecandidate = null;
      liveViewConnection.ontrack = null;
      liveViewConnection.close();
      liveViewConnection = null;
    }
    pendingIceCandidates = [];
    getElement('liveMedia').srcObject = null;
    getElement('videoContainer').hidden = true;
    window.MonitorApp.showMovementBox(getElement('movementBox'), null);
  }

  getElement('listenButton').addEventListener('click', () => startReceivingLiveView(false));
  getElement('watchButton').addEventListener('click', () => startReceivingLiveView(true));
  getElement('stopLiveViewButton').addEventListener('click', () => {
    requestedLiveView = null;
    stopReceivingLiveView();
    if (serverConnection) serverConnection.sendMessage({ type: 'stop-live-view' });
    showLiveViewMessage('Not streaming.');
  });

  // ---------------------------------------------------------------- talk to the baby (WebRTC)
  // Tap once to start talking, tap again to stop. The microphone is opened only while talking,
  // goes straight to the baby unit over the home network, and is never recorded.
  function showTalkMessage(message) { getElement('talkMessage').textContent = message; }

  function showTalkButton() {
    const talkButton = getElement('talkButton');
    talkButton.textContent = isTalking ? 'Stop talking' : 'Talk to baby';
    talkButton.className = 'btn ' + (isTalking ? 'danger' : 'primary');
  }

  async function startTalking() {
    if (isTalking) return;
    if (!isBabyUnitOnline || !serverConnection) { showTalkMessage('The baby unit is not connected.'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showTalkMessage('The microphone needs a secure connection. Open the https:// link.');
      return;
    }
    isTalking = true;   // set now, so a second tap while the microphone permission is pending stops it
    showTalkButton();
    showTalkMessage('Opening the microphone…');
    let microphoneStream;
    try {
      microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (microphoneError) {
      isTalking = false;
      showTalkButton();
      showTalkMessage('Could not open the microphone (' + microphoneError.name + '). Allow microphone access and try again.');
      return;
    }
    if (!isTalking || !serverConnection) {   // stopped while the permission prompt was open
      microphoneStream.getTracks().forEach((track) => track.stop());
      return;
    }
    talkMicrophoneStream = microphoneStream;
    const thisConnection = new RTCPeerConnection({ iceServers: [] });
    talkConnection = thisConnection;
    pendingTalkCandidates = [];
    microphoneStream.getAudioTracks().forEach((track) => thisConnection.addTrack(track, microphoneStream));
    thisConnection.getTransceivers().forEach((transceiver) => { transceiver.direction = 'sendonly'; });
    thisConnection.onicecandidate = (event) => {
      if (event.candidate && serverConnection) {
        serverConnection.sendMessage({ type: 'talk-signal', signal: { iceCandidate: event.candidate } });
      }
    };
    thisConnection.onconnectionstatechange = () => {
      if (talkConnection !== thisConnection) return;
      if (thisConnection.connectionState === 'connected') {
        showTalkMessage('Talking: the baby unit is playing your voice. Tap to stop.');
      } else if (thisConnection.connectionState === 'failed') {
        stopTalking(true);
        showTalkMessage('Could not reach the baby unit. Try again.');
      }
    };
    talkAutoStopTimer = setTimeout(() => {
      stopTalking(true);
      showTalkMessage('Talking stopped by itself after 2 minutes.');
    }, TALK_AUTO_STOP_MILLISECONDS);
    showTalkMessage('Connecting…');
    try {
      await thisConnection.setLocalDescription(await thisConnection.createOffer());
      if (talkConnection === thisConnection && serverConnection) {
        serverConnection.sendMessage({ type: 'talk-signal', signal: { sessionDescription: thisConnection.localDescription } });
      }
    } catch {
      if (talkConnection === thisConnection) { stopTalking(true); showTalkMessage('Could not start talking. Try again.'); }
    }
  }

  function stopTalking(shouldTellBabyUnit) {
    const wasTalking = isTalking;
    isTalking = false;
    clearTimeout(talkAutoStopTimer);
    talkAutoStopTimer = null;
    if (talkConnection) {
      talkConnection.onconnectionstatechange = null;
      talkConnection.onicecandidate = null;
      talkConnection.close();
      talkConnection = null;
    }
    pendingTalkCandidates = [];
    if (talkMicrophoneStream) {   // release the microphone so the "recording" indicator goes off
      talkMicrophoneStream.getTracks().forEach((track) => track.stop());
      talkMicrophoneStream = null;
    }
    if (shouldTellBabyUnit && wasTalking && serverConnection) serverConnection.sendMessage({ type: 'stop-talking' });
    showTalkButton();
    showTalkMessage(DEFAULT_TALK_MESSAGE);
  }

  async function handleTalkSignalFromBabyUnit(signal) {
    const thisConnection = talkConnection;
    if (!thisConnection || !signal) return;
    try {
      if (signal.sessionDescription) {
        await thisConnection.setRemoteDescription(signal.sessionDescription);
        for (const candidate of pendingTalkCandidates.splice(0)) {
          await thisConnection.addIceCandidate(candidate).catch(() => {});
        }
      } else if (signal.iceCandidate) {
        if (thisConnection.remoteDescription) await thisConnection.addIceCandidate(signal.iceCandidate).catch(() => {});
        else pendingTalkCandidates.push(signal.iceCandidate);
      }
    } catch {
      if (talkConnection === thisConnection) { stopTalking(true); showTalkMessage('Could not start talking. Try again.'); }
    }
  }

  function handleTalkRefused(reason) {
    stopTalking(false);
    showTalkMessage(TALK_REFUSAL_MESSAGES[reason] || 'The baby unit could not accept your voice.');
  }

  getElement('talkButton').addEventListener('click', () => {
    if (isTalking) stopTalking(true);
    else startTalking();
  });

  // ---------------------------------------------------------------- movement clips (from the baby unit's memory)
  // The parent opens a data channel straight to the baby unit (WebRTC, never via the server), asks for the
  // list of clips and fetches one when tapped. Nothing is stored on this device: a clip is held in memory
  // only while it is shown.
  function showClipMessage(message) { getElement('clipMessage').textContent = message; }

  function connectToClips() {
    closeClipConnection();
    if (!isBabyUnitOnline || !serverConnection) return;
    const thisConnection = new RTCPeerConnection({ iceServers: [] });
    clipConnection = thisConnection;
    const channel = thisConnection.createDataChannel('clips');
    clipChannel = channel;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => channel.send(JSON.stringify({ type: 'list' }));
    channel.onmessage = (event) => handleClipChannelMessage(event.data);
    channel.onclose = () => { if (clipChannel === channel) { closeClipConnection(); scheduleClipReconnect(); } };
    thisConnection.onicecandidate = (event) => {
      if (event.candidate && serverConnection) {
        serverConnection.sendMessage({ type: 'clip-signal', signal: { iceCandidate: event.candidate } });
      }
    };
    thisConnection.onconnectionstatechange = () => {
      if (clipConnection !== thisConnection) return;
      if (thisConnection.connectionState === 'failed') { closeClipConnection(); scheduleClipReconnect(); }
    };
    showClipMessage('Connecting to the baby unit…');
    thisConnection.createOffer().then((offer) => thisConnection.setLocalDescription(offer)).then(() => {
      if (clipConnection === thisConnection && serverConnection) {
        serverConnection.sendMessage({ type: 'clip-signal', signal: { sessionDescription: thisConnection.localDescription } });
      }
    }).catch(() => {});
  }

  function scheduleClipReconnect() {
    if (clipRetryTimer) return;
    clipRetryTimer = setTimeout(() => {
      clipRetryTimer = null;
      if (hasJoined && isBabyUnitOnline && !clipConnection) connectToClips();
    }, CLIP_RECONNECT_DELAY_MILLISECONDS);
  }

  function closeClipConnection() {
    if (clipChannel) { clipChannel.onclose = null; clipChannel.onmessage = null; clipChannel.onopen = null; }
    if (clipConnection) {
      clipConnection.onconnectionstatechange = null;
      clipConnection.onicecandidate = null;
      clipConnection.close();
    }
    clipConnection = null;
    clipChannel = null;
    pendingClipCandidates = [];
    incomingClip = null;
    loadingClipId = null;
    availableClips = [];
    showClipList();
  }

  async function handleClipSignalFromBabyUnit(signal) {
    const thisConnection = clipConnection;
    if (!thisConnection || !signal) return;
    try {
      if (signal.sessionDescription) {
        await thisConnection.setRemoteDescription(signal.sessionDescription);
        for (const candidate of pendingClipCandidates.splice(0)) {
          await thisConnection.addIceCandidate(candidate).catch(() => {});
        }
      } else if (signal.iceCandidate) {
        if (thisConnection.remoteDescription) {
          await thisConnection.addIceCandidate(signal.iceCandidate).catch(() => {});
        } else if (pendingClipCandidates.length < MAX_WAITING_ICE_CANDIDATES) {
          pendingClipCandidates.push(signal.iceCandidate);
        }
      }
    } catch {
      if (clipConnection === thisConnection) { closeClipConnection(); scheduleClipReconnect(); }
    }
  }

  function handleClipChannelMessage(data) {
    if (typeof data !== 'string') {   // a piece of the clip being loaded
      if (!incomingClip) return;
      incomingClip.chunks.push(data);
      incomingClip.receivedBytes += data.byteLength;
      if (incomingClip.receivedBytes > incomingClip.sizeBytes) { loadingClipId = null; incomingClip = null; showClipMessage('The clip could not be loaded.'); showClipList(); return; }
      showClipMessage('Loading clip… ' + Math.round(100 * incomingClip.receivedBytes / Math.max(1, incomingClip.sizeBytes)) + '%');
      return;
    }
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'list' && Array.isArray(message.clips)) {
      availableClips = message.clips.filter((clip) => clip && typeof clip.id === 'string' &&
        Number.isFinite(clip.startedAt) && Number.isFinite(clip.durationSeconds) && Number.isFinite(clip.sizeBytes));
      showClipList();
    } else if (message.type === 'clip-start' && message.id === loadingClipId && Number.isFinite(message.sizeBytes)) {
      incomingClip = {
        id: message.id, sizeBytes: message.sizeBytes, chunks: [], receivedBytes: 0,
        mimeType: /^video\/(webm|mp4)/.test(message.mimeType) ? message.mimeType : 'video/webm',
      };
    } else if (message.type === 'clip-end' && incomingClip && message.id === incomingClip.id) {
      showReceivedClip();
    } else if (message.type === 'clip-missing') {
      loadingClipId = null;
      incomingClip = null;
      showClipMessage('That clip is no longer available.');
      if (clipChannel && clipChannel.readyState === 'open') clipChannel.send(JSON.stringify({ type: 'list' }));
    }
  }

  function describeClipTime(clip) {
    const startTime = new Date(Number.isFinite(clip.movementAt) ? clip.movementAt : clip.startedAt);   // when the movement began
    const timeText = startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return startTime.toDateString() === new Date().toDateString() ? timeText : startTime.toLocaleDateString() + ' ' + timeText;
  }

  function showClipList() {
    const clipList = getElement('clipList');
    clipList.replaceChildren();
    [...availableClips].reverse().forEach((clip) => {   // newest first
      const listItem = document.createElement('li');
      const playButton = document.createElement('button');
      playButton.type = 'button';
      playButton.className = 'btn';
      playButton.disabled = loadingClipId !== null;
      playButton.textContent = 'Movement at ' + describeClipTime(clip) + ' · ' + clip.durationSeconds + ' s · ' + (clip.sizeBytes / 1048576).toFixed(1) + ' MB';
      playButton.addEventListener('click', () => requestClip(clip.id));
      listItem.appendChild(playButton);
      clipList.appendChild(listItem);
    });
    if (clipChannel && clipChannel.readyState === 'open' && !loadingClipId) {
      showClipMessage(availableClips.length
        ? availableClips.length + ' clip' + (availableClips.length > 1 ? 's' : '') + ' (times are from the baby unit). Tap one to watch it.'
        : 'No clips saved yet. When movement is detected, a clip is saved from 10 seconds before it to 20 seconds after.');
    }
  }

  function requestClip(clipId) {
    if (loadingClipId || !clipChannel || clipChannel.readyState !== 'open') return;
    loadingClipId = clipId;
    showClipMessage('Loading clip…');
    showClipList();
    clipChannel.send(JSON.stringify({ type: 'get', id: clipId }));
  }

  function showReceivedClip() {
    const clip = incomingClip;
    incomingClip = null;
    loadingClipId = null;
    const clipBlob = new Blob(clip.chunks, { type: clip.mimeType });
    if (clipBlob.size !== clip.sizeBytes) {
      showClipMessage('The clip arrived incomplete. Tap it to try again.');
      showClipList();
      return;
    }
    hideClipPlayer();
    shownClipUrl = URL.createObjectURL(clipBlob);
    const clipPlayer = getElement('clipPlayer');
    clipPlayer.src = shownClipUrl;
    clipPlayer.hidden = false;
    clipPlayer.play().catch(() => {});
    showClipList();
    showClipMessage('Playing the clip. It is only held in memory while you watch it.');
  }

  function hideClipPlayer() {
    const clipPlayer = getElement('clipPlayer');
    clipPlayer.pause();
    clipPlayer.removeAttribute('src');
    clipPlayer.hidden = true;
    if (shownClipUrl) { URL.revokeObjectURL(shownClipUrl); shownClipUrl = null; }
  }

  getElement('deleteClipsButton').addEventListener('click', () => {
    hideClipPlayer();
    if (clipChannel && clipChannel.readyState === 'open') clipChannel.send(JSON.stringify({ type: 'delete-all' }));
  });

  // ---------------------------------------------------------------- remote settings for the baby unit
  function sendSettingsToBabyUnit() {
    getElement('soundSensitivityValue').textContent = getElement('soundSensitivity').value;
    clearTimeout(settingsSendTimer);
    settingsSendTimer = setTimeout(() => {
      if (serverConnection) {
        serverConnection.sendMessage({
          type: 'change-settings',
          soundSensitivity: +getElement('soundSensitivity').value,
          movementAlertsEnabled: getElement('movementAlertsCheckbox').checked,
          recordClipsEnabled: getElement('recordClipsCheckbox').checked,
        });
      }
    }, SETTINGS_SEND_DELAY_MILLISECONDS);
  }
  getElement('soundSensitivity').addEventListener('input', sendSettingsToBabyUnit);
  getElement('movementAlertsCheckbox').addEventListener('change', sendSettingsToBabyUnit);
  getElement('recordClipsCheckbox').addEventListener('change', sendSettingsToBabyUnit);
})();
