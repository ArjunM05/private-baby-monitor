// Shared helpers: WebSocket connection to the local server (with auto-reconnect) and screen wake lock.
(() => {
  'use strict';

  const MAX_RECONNECT_DELAY_MILLISECONDS = 5000;
  const FIRST_RECONNECT_DELAY_MILLISECONDS = 400;
  const SOCKET_OPEN_STATE = 1;

  // handlers: { onConnectionStateChange('online' | 'offline'), onJoinDenied(reason), onServerMessage(message) }
  // babyUnitId is only sent by the baby unit: it lets the server tell "the same device reconnecting"
  // apart from "a different device trying to become the baby unit".
  function createServerConnection(role, pin, handlers, babyUnitId) {
    let socket = null, reconnectAttempts = 0, reconnectTimer = null, isDisconnectedOnPurpose = false;

    function connect() {
      if (isDisconnectedOnPurpose) return;
      const thisSocket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
      socket = thisSocket;
      thisSocket.onopen = () => thisSocket.send(JSON.stringify({ type: 'join', role, pin, babyUnitId }));
      thisSocket.onmessage = (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'joined') {
          reconnectAttempts = 0;
          handlers.onConnectionStateChange('online');
        } else if (message.type === 'denied') {
          isDisconnectedOnPurpose = true;
          handlers.onJoinDenied(message.reason);
          return;
        }
        handlers.onServerMessage(message);
      };
      thisSocket.onclose = () => {
        if (thisSocket !== socket || isDisconnectedOnPurpose) return;
        handlers.onConnectionStateChange('offline');
        const delay = Math.min(MAX_RECONNECT_DELAY_MILLISECONDS,
                               FIRST_RECONNECT_DELAY_MILLISECONDS * 2 ** reconnectAttempts++);
        reconnectTimer = setTimeout(connect, delay);
      };
      thisSocket.onerror = () => {};
    }

    return {
      connect,
      sendMessage(message) {
        if (socket && socket.readyState === SOCKET_OPEN_STATE) {
          socket.send(JSON.stringify(message));
          return true;
        }
        return false;
      },
      disconnect() {
        isDisconnectedOnPurpose = true;
        clearTimeout(reconnectTimer);
        if (socket) socket.close();
      },
    };
  }

  let shouldKeepScreenAwake = false;

  async function requestScreenWakeLock() {
    try {
      if ('wakeLock' in navigator) await navigator.wakeLock.request('screen');
    } catch { /* not supported or refused */ }
  }

  document.addEventListener('visibilitychange', () => {
    if (shouldKeepScreenAwake && document.visibilityState === 'visible') requestScreenWakeLock();
  });

  // box: { left, top, width, height } as fractions (0 to 1) of the picture, or null to hide the box.
  // The box element must sit directly on top of the video, covering exactly the same area.
  function showMovementBox(boxElement, box) {
    if (!box) {
      boxElement.hidden = true;
      return;
    }
    boxElement.style.left = box.left * 100 + '%';
    boxElement.style.top = box.top * 100 + '%';
    boxElement.style.width = box.width * 100 + '%';
    boxElement.style.height = box.height * 100 + '%';
    boxElement.hidden = false;
  }

  window.MonitorApp = {
    createServerConnection,
    showMovementBox,
    keepScreenAwake() {
      shouldKeepScreenAwake = true;
      return requestScreenWakeLock();
    },
  };
})();
