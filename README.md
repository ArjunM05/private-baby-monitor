# Home baby monitor

Turn two devices you already own into a baby monitor.

- One device stays in the baby's room with its camera and microphone pointed at the cot. This guide calls it the **baby unit**.
- Your phone, tablet or laptop is the **parent unit**. It sounds an alarm when the baby unit hears crying, and lets you watch, listen and talk to the baby.

It works over your **home Wi-Fi only**. There are no accounts, no subscription and nothing goes to the internet. By default, **nothing is recorded**.

---

## Please read first: safety

This is a hobby project. It is **not** a medical device, and it **cannot tell whether your baby is breathing**. Never use it as your only way of knowing your baby is safe.

- **Test it before you trust it.** Play a recording of a baby crying near the baby unit and check the parent unit's alarm sounds. Then switch off the baby unit's Wi-Fi and check you get the "Baby unit offline" alarm.
- **Plug in both devices**, keep the monitor page open and keep the screen on. Phones often pause pages that are in the background or locked, and then the alarm will not sound.
- Both devices must be on the **same Wi-Fi**. If the Wi-Fi drops, the monitor tells you.

---

## What you need

- **A computer that stays on while you use the monitor.** It runs the small program that connects your devices. Windows or Mac is easiest. It can also be the baby unit itself.
- **A baby unit:** an old phone, a tablet, or a laptop with a webcam. An old Android phone with Chrome works best.
- **A parent unit:** any phone, tablet or laptop with a web browser.
- **Python**, a free program the monitor needs. The launcher below helps you install it once.

A Wi-Fi camera (the kind you mount on a wall) will **not** work, because it cannot open the monitor page.

---

## Set up (about 10 minutes, once)

### Step 1: Start the monitor on the computer

1. Open the monitor folder.
2. Double-click **`Start Baby Monitor.bat`** (Windows) or **`Start Baby Monitor.command`** (Mac).
   - **On a Mac the first time:** right-click the file, choose **Open**, then **Open** again.
   - **If it says Python is missing:** install it from python.org. On Windows, tick **"Add python.exe to PATH"** during the install. Then double-click the file again.
3. The first time, it spends about a minute setting itself up. This needs the internet **once**.
4. A browser window opens and a black window shows a **6-digit PIN**. Keep that window open for as long as you want the monitor running.

Closing the black window stops the monitor. A **new PIN** is made each time you start it.

### Step 2: Open the monitor on both devices

On the baby unit **and** on your device, with both on the same Wi-Fi, open the link shown in the black window (or scan the QR code next to it).

Your browser will probably say the connection is **"not private"** or **"not secure"**. This is expected. The monitor makes its own security certificate because an official one is not possible for a home network. Look for **Advanced** or **Show details** and choose to **continue**. You only do this once per device.

### Step 3: Set up the baby unit

1. Tap **This is the baby's device**.
2. Type the PIN and tap **Start monitoring**.
3. Allow the camera and microphone when asked.
4. Keep the room quiet for 3 seconds while it learns the normal background sound.
5. Put the device near the cot with the camera facing the baby, and plug it in.

If you will use a fan or white-noise machine, switch it on **before** pressing Start.

### Step 4: Set up your device

1. Tap **This is my device**.
2. Type the PIN and tap **Connect**.
3. Tap **Test alarm** to check you can hear and see the alarm.

You are ready. Any other parent can do Step 4 on their own phone, and all of them get the alarm.

---

## Using the monitor

**When the baby makes a noise**, the parent unit plays a loud repeating tone, vibrates and shows a full-screen alert.
- **Dismiss** silences the alarm (on every parent's device).
- **Snooze 10 minutes** pauses alerts while you settle the baby.

**Buttons on the parent unit**
- **Listen:** hear the room live. This uses less battery than video.
- **Watch:** see and hear the baby live.
- **Stop:** end the live view.
- **Talk to baby:** your voice plays from the baby unit. Tap again to stop.
- **Sound sensitivity (1–10):** higher means more alerts. The little orange mark on the meter shows where an alert starts.

**On the baby unit**
- **Dim screen** turns the screen black. It also dims itself after 30 seconds. Tap to wake it.
- **Stop** ends monitoring.

### What triggers an alarm

| What happened | What the alarm says |
|---|---|
| Steady crying-like sound, clearly louder than the room's usual noise | "Baby is making noise" |
| Movement (only if you switch this on) | "Movement" |
| The baby unit stopped reporting (battery, Wi-Fi, frozen page) | "Baby unit offline" |
| The baby unit's microphone stopped working | "Baby unit problem" |
| Your device lost its connection | "Connection lost" |

The last three matter: a monitor that fails silently is worse than none.

**Movement alerts are off by default**, because babies move a lot in their sleep. Tick **Also alert on movement** if you want them.

### Several parents, one baby unit

- Any number of parents can connect.
- Only **one** device can be the baby unit. If a second device tries, it is refused.
- If the baby unit reconnects after a Wi-Fi drop, it takes its place again. To swap to a different device, press **Stop** on the old one first, or wait about 30 seconds after switching it off.

---

## Talking to the baby

Tap **Talk to baby**, allow the microphone the first time, and speak. Tap again to stop.

- Only **one parent can talk at a time**. Others see "Another parent is talking" and can try again soon.
- The microphone is on **only while you talk**, and it **switches itself off after 2 minutes**.
- While you talk, **you will not hear the baby**. This stops the two devices squealing at each other.
- While your voice is playing, and for 3 seconds after, the baby unit **pauses its crying alerts**. Otherwise it would hear your voice and raise a false alarm.
- Turn the baby unit's volume to a level that suits a sleeping baby.

---

## Movement clips (optional, off by default)

This is the one exception to "nothing is recorded". Tick **Save a short clip when movement is detected** on a parent device or on the baby unit to turn it on.

When the monitor sees steady movement, it keeps a clip from **10 seconds before** the movement to **20 seconds after** it. On your device, the **Movement clips** list shows each one, for example "Movement at 12:34:05 · 40 s". Tap one to watch it with sound.

**What you should know**
- **Clips live in memory only.** The baby unit holds the last **10** and drops the oldest. Nothing is saved to a file by this app.
- **They disappear** when you press **Stop** on the baby unit, close or reload its page, lose its power, or tap **Delete all clips**.
- **A clip appears about 20 seconds after the movement stops,** because it includes the 20 seconds that follow.
- **Clips only play on your device when you tap them,** and travel straight from the baby unit over your Wi-Fi. Your browser's own "download video" option could save a copy, so avoid it if you don't want one.
- **It is a simple movement check, not an intelligent one.** A clip may show a curtain or a blanket moving. A baby lying perfectly still produces no clip.
- **While it is on,** the baby unit keeps a few seconds of video in memory and works a little harder. An older phone may get warm, so switch it off when you do not need it.
- If the baby unit's browser can't record video, this setting does nothing.

---

## Your privacy

- **Everything stays on your Wi-Fi.** The monitor's pages load nothing from the internet, and live video and sound go straight from the baby unit to your device.
- **Nothing is recorded** unless you switch on movement clips, and those stay in memory only.
- **The server keeps no logs, history or database.** The only file it creates is a security certificate.
- **A 6-digit PIN is needed to join.** It is **not** in the link or the QR code, so sharing the link does not share access. After five wrong guesses, a device is locked out for 5 minutes.

---

## If something goes wrong

**The baby unit says "Could not open camera/microphone" or "The camera needs a secure connection".**
Use the link that starts with `https://`, accept the warning (Step 2), and tap **Allow** when it asks for the camera and microphone. If you tapped Block by mistake, change it in the browser's site settings. On iPhones, camera access can be stubborn with this kind of certificate. If it won't work, use an Android phone with Chrome as the baby unit.

**My other device can't open the page.**
Check both devices are on the same Wi-Fi. A "guest" network often blocks this. Also allow Python through the computer's firewall if asked.

**The live view stays on "Connecting…" (also for Talk to baby).**
Some routers stop devices talking to each other. Look for a setting called **client isolation** or **AP isolation** in the router and turn it off. The alarms still work without it.

**I changed the computer or its address and now get a warning.**
This is normal. Accept the warning again.

**I get too many alarms, or too few.**
Change **Sound sensitivity** and watch the meter. If a fan or white-noise machine was switched on *after* you started, stop and start monitoring again.

**It can't tell crying from other noise.**
Correct. It detects *sound*, so a loud TV or someone talking in the room can set it off.

**"Tap here to allow the parent's voice to play" appears on the baby unit.**
Some phones, iPhones especially, will not play sound until the screen is tapped. Tap the button once.

**No movement clips appear.**
Make sure the clips box is ticked, and remember a clip needs steady movement and appears about 20 seconds after it stops.

**"Could not open the microphone" when talking.**
Allow microphone access for the page in your browser's settings. It needs the `https://` link.

---

## For the technically curious

### How it works

```
 Baby unit (phone/laptop)                    Your computer                Parent unit
 ┌──────────────────────┐   alerts/status   ┌──────────────┐   alerts    ┌────────────┐
 │ camera + mic         │ ───────────────►  │  server.py   │ ──────────► │ alarm,     │
 │ sound/motion analysed│                   │ (relay only) │             │ meters     │
 │ ON THIS DEVICE       │ ◄─────────────────┴──────────────┴─────────────┤            │
 └──────────┬───────────┘                                                └─────▲──────┘
            └──────────  live audio/video, device to device (WebRTC)  ─────────┘
```

- The server only relays small text messages (alerts, levels, connection handshakes). Audio and video never pass through it.
- Detection runs inside the baby unit's browser. Movement clips are held in that page's memory and sent to a parent directly over a WebRTC data channel only when the parent asks.
- A strict Content-Security-Policy blocks the pages from loading anything from the internet. The live stream uses no STUN/TURN servers, so it cannot leave your network.

### Running it from a terminal

Needs Python 3.9 or newer.

```bash
pip install -r requirements.txt
python server.py
```

Options: `--port 8443`, `--pin 123456` (a fixed PIN instead of a new one each run), `--host 127.0.0.1` (this computer only), `--open-browser`.

### How detection works, and its limits

This is classic signal processing, not a trained AI model.

- **Sound:** it measures loudness over the last few seconds and the share of energy in the 250–4000 Hz band, where crying and voices live. It alerts when the sound is clearly above the room's own background level, mostly in that band, and lasts about 1.2 seconds or more. Brief bumps and low rumbles are ignored.
- **Movement:** each video frame is shrunk to a tiny greyscale copy and compared with the one before. The orange "movement" box outlines the area that changed, glides smoothly, and lingers about 1.5 seconds after the movement stops. It cannot tell a baby from a hand, a blanket or a pet, and it cannot see a baby who is lying perfectly still. Poor lighting adds picture noise, which can make the box flicker or fill too much of the picture.

### Files

```
Start Baby Monitor.bat / .command   double-click launchers
server.py            HTTPS + relay (no storage); creates certs/ on first run
static/baby.*        baby unit page: capture, analysis, video sender, plays the parent's voice, clip recorder
static/parent.*      parent unit page: alarm, meters, video receiver, talk-to-baby microphone, clip list and player
static/common.js     shared server link and screen wake lock
```
