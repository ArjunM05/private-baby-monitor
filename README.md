# Local baby monitor

One device (the **baby unit**) watches and listens. Another (the **parent unit**) sounds an alarm when it hears crying, and can play live audio/video on request and lets you talk to the baby. Everything runs on your home Wi-Fi. No cloud, no accounts, and nothing is recorded unless you switch on the optional movement clips (kept in memory only, see below).

## How it works

```
 Baby unit (phone/laptop)                    Your computer                Parent unit
 ┌──────────────────────┐   alerts/status   ┌──────────────┐   alerts    ┌────────────┐
 │ camera + mic         │ ───────────────►  │  server.py   │ ──────────► │ alarm,     │
 │ sound/motion analysed│                   │ (relay only) │             │ meters     │
 │ ON THIS DEVICE       │ ◄─────────────────┴──────────────┴─────────────┤            │
 └──────────┬───────────┘                                                └─────▲──────┘
            └──────────  live audio/video, device to device (WebRTC)  ─────────┘
```

- The server only relays tiny text messages (alerts, levels, connection handshakes). **Audio and video never pass through it**; they go straight between the baby unit and the parent unit, and only while the parent taps *Listen*, *Watch* or *Talk to baby*. Your voice is never recorded or stored either: the parent device's microphone is only on while you are talking.
- Detection runs inside the baby unit's browser. **By default nothing is recorded.** The only optional exception is *Movement clips* (below), which is off until you tick it, holds clips in the baby unit's memory only, and is never written to a file by this app. There are no uploads, no logs and no database. The only files created are a self-signed certificate in `certs/`.
- The pages load nothing from the internet (enforced by a strict Content-Security-Policy), and the live stream uses no STUN/TURN servers, so it cannot leave your network.
- A random 6-digit PIN (new each run) is required to join. Five wrong attempts lock that device out for 5 minutes.

## Setup

Needs Python 3.9+ on any computer that stays on during use (it can also be the baby unit itself).

**Easiest:** double-click `Start Baby Monitor.bat` (Windows) or `Start Baby Monitor.command` (Mac). The first run installs what it needs (internet required once) and opens the monitor in your browser. On a Mac, the first time, right-click the file and choose Open. If you prefer a terminal:

```bash
pip install -r requirements.txt
python server.py
```

It prints a link, a QR code and a PIN. The PIN is deliberately **not** part of the link or the QR code, so you type it on each device and sharing the link never shares access. On **both** devices, connected to the same Wi-Fi:

1. Open the link (or scan the QR code). Each device shows a certificate warning the first time, because the certificate is self-signed. Accept it (Advanced → Proceed). HTTPS is required for browsers to allow camera and microphone access.
2. On the baby's device choose **This is the baby's device**, type the PIN, tap **Start monitoring**, allow camera and microphone, and leave the room quiet for the 3-second calibration.
3. On yours choose **This is my device**, type the PIN, tap **Connect**, then **Test alarm** to confirm you can hear it and see it.

Options: `--port 8443`, `--pin 123456` (fixed PIN, so you do not have to read a new one each run), `--host 127.0.0.1` (this computer only).

## Using it

- **Alarm:** a loud repeating tone, vibration and a full-screen alert. *Dismiss* silences it; *Snooze 10 minutes* pauses sound/movement alerts while you are soothing the baby.
- **Several parents, one baby unit:** any number of parent devices can connect. All of them get the alerts, and dismissing the alarm on one silences it on the others. Only one device can be the baby unit: a second device that tries to start as one is refused. The baby device remembers its identity, so it can reconnect after a Wi-Fi drop or a reload. If you want to switch to a different device, stop the old one first, or wait about 30 seconds after switching it off.
- **Listen / Watch:** audio only is lighter on battery; Watch adds video.
- **Movement clips (optional, off by default):** tick *Save a short clip when movement is detected* on a parent device or on the baby unit. When the same sustained movement that triggers the movement alert is seen, the baby unit keeps a clip that runs from **10 seconds before the movement to 20 seconds after the last movement** (a very long movement is cut at 60 seconds after it started). The parent's *Movement clips* list shows each one as "Movement at 12:34:05 · 40 s"; tap it to watch it with sound. Good to know:
  - **Memory only.** Clips are held in the baby unit page's memory (the last **10**, oldest dropped first, and never more than 40 MB). This app never writes them to a file. They are gone when you press *Stop* on the baby unit, close or reload its page, or tap *Delete all clips* (on a parent or on the baby unit). A parent fetches a clip straight from the baby unit over your Wi-Fi (never through the server) only when you tap it, and plays it from memory; it is not saved on the parent either (a browser's own "download video" menu item could save it, so don't use that if you don't want a copy).
  - **How the 10 seconds "before" works.** While clips are switched on, the baby unit keeps recording in short overlapping pieces and throws each piece away after 20 seconds unless movement was detected. So while it is switched on there is always a few seconds of video sitting in memory, and the baby unit does a little more work (it encodes video continuously), which can make an older phone warm. Switch it off when you do not need it.
  - **It shows what the camera saw, not what happened.** It uses the same simple movement detection as the alert (no AI), so a clip can show a curtain or a blanket moving, and a baby lying still produces no clip. The baby unit must stay open for clips to exist. Unplugging it or closing its page loses them.
  - If the baby unit's browser cannot record video (some older browsers), the setting simply does nothing.
- **Talk to baby:** tap it once to start talking (your voice plays from the baby unit's speaker) and tap again to stop. The first time, allow the microphone. It switches itself off after 2 minutes so the microphone is never left on by accident. Turn the baby unit's volume to a level that suits a sleeping baby. Rules that keep it simple and safe:
  - Only **one parent can talk at a time**; a second parent is told "Another parent is talking" and can try again once the first stops.
  - While you talk, the baby unit's microphone is **not** sent back to you (you would hear yourself and the two devices could squeal), so you will not hear the baby until you stop. Other parents who are listening still hear everything.
  - While a parent's voice is playing, and for 3 seconds after, the baby unit **pauses its sound alerts** (its microphone would otherwise hear your own voice from the speaker and raise a false alarm). Movement alerts and the "offline" alarms keep working.
- **Sensitivity (1-10)** can be changed from either device. **Also alert on movement** is off by default because babies move a lot in their sleep.
- **Dim screen** on the baby unit shows a black screen (it also dims itself after 30 s). Tap to wake.

### What it alerts on

| Situation | Parent unit alarm |
|---|---|
| Sustained sound in the voice/cry range, clearly above the room's usual level | "Baby is making noise" |
| Movement (if enabled) | "Movement" |
| Baby unit stops reporting (battery, Wi-Fi, page frozen) | "Baby unit offline" |
| Baby unit's microphone stops working | "Baby unit problem" |
| Parent unit loses its connection to the server | "Connection lost" |

The last three matter: a monitor that fails silently is worse than none.

### How detection works (and its limits)

This is classic signal processing, not a trained AI model. It measures loudness over the last few seconds and the share of energy in the 250-4000 Hz band where crying and voices live. It alerts when the sound is clearly above the **room's own background level** (measured at start-up and tracked as it changes), mostly in that band, and lasts about 1.2 s or more. Brief bumps and low rumbles are ignored. The meters show the current level and the alert threshold, so you can tune sensitivity by watching them.

- It cannot tell crying from a loud TV or a person talking in the room. It detects *sound*.
- **The orange "movement" box** (on the baby unit's preview and on the parent's live video) outlines the area of the picture that changed since the previous frame (tiny specks are ignored). It uses no AI model: each frame is shrunk to a tiny greyscale copy and compared with the one before. The box glides, and lingers for about 1.5 s after the movement stops. It **cannot tell a baby from a hand, a blanket or a pet, and it cannot see a baby who is lying perfectly still**. Poor lighting adds picture noise, which can make it flicker or fill too much of the picture.
- If a white-noise machine or fan will be on, switch it on **before** pressing Start, so it becomes part of the background. Turning one on afterwards will trigger repeated alerts until you restart monitoring.

## Please read: safety

This is a hobby project, not a medical device or a certified safety product, and it does not detect breathing. Do not rely on it as your only way of knowing your baby is safe. Before trusting it on a real night, test it: let the baby unit hear a recording of crying from across the room, confirm the alarm sounds, then unplug the baby unit's Wi-Fi and confirm the "offline" alarm.

Both devices should be **plugged in**, with the **page open and the screen on**. Phone browsers may pause pages that are in the background or locked, which would stop alerts. The pages request a screen wake lock to help, but it cannot be guaranteed on every phone. It also only works while both devices are on the same Wi-Fi network.

## Troubleshooting

- **"Can't open camera"**: you must use the `https://` link and accept the certificate warning. On iPhone, camera access over a self-signed certificate can be stubborn; if it won't work, use Chrome/Android for the baby unit or install [mkcert](https://github.com/FiloSottile/mkcert) and point `certs/cert.pem` and `certs/key.pem` at a certificate it generates (include your computer's IP).
- **Other device can't reach the page**: check both are on the same Wi-Fi (not a "guest" network with client isolation) and allow Python through the computer's firewall for the chosen port.
- **Certificate error after your computer's IP changed**: the certificate is regenerated automatically on next start; accept the warning again.
- **Live view stays on "Connecting…"**: some routers block device-to-device traffic (client/AP isolation). Disable it, or use the alerts only.
- **"Tap here to allow the parent's voice to play" appears on the baby unit**: some phones (iPhones especially) refuse to play sound until the screen is tapped. Tap that button once; after that the parent's voice plays normally.
- **No movement clips appear**: tick *Save a short clip when movement is detected*, and note that a clip is only kept for sustained movement (about 2.5 seconds of it within 4 seconds, the same as the movement alert). The first clip appears about 20 seconds after the movement stops, because it records the 20 seconds after.
- **Talk to baby says it could not open the microphone**: allow microphone access for the page in the browser's site settings (it needs the `https://` link) and try again.
- **Talk to baby stays on "Connecting…"**: it uses the same device-to-device connection as Listen/Watch, so the router isolation fix above applies.
- **Too many / too few alerts**: adjust sensitivity and watch the meters; the orange mark is the alert threshold.

## Files

```
server.py            HTTPS + relay (no storage); creates certs/ on first run
static/baby.*        baby unit page: capture, analysis, WebRTC sender, plays the parent's voice
static/parent.*      parent unit page: alarm, meters, WebRTC receiver, talk-to-baby microphone, movement clip list and player
static/common.js     shared WebSocket link and wake lock
```
