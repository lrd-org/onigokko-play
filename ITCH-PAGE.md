# itch.io page copy — Onigokko v0.1

Draft for pasting. The slug/URL is yours to pick; nothing below assumes one.

---

## Title

```
Onigokko
```

## Short tagline (≤ 60 chars)

```
Wordless 75-second chase. Drive, jump, don't get caught.
```

(56 characters.)

## Description (paste into the page body)

```
Onigokko is a wordless, solo browser game. One round is 75 seconds.

You drive a small round creature across an open world of rolling green
swells. Ride a crest fast enough and you fly. Two hunters are chasing you
the whole time; every time one reaches you, you lose a pip of health. The
friendly yellow creatures scattered across the world are points — run them
down, and catch them in quick succession to build a chain.

There is no text anywhere in the game. The title card, the controls, the
pause screen and the result card are all pictures, so it plays the same in
any language.

Controls:

  W  /  Up          throttle
  S  /  Down        brake
  A  D  /  Left  Right    steer
  Shift  or  Space  boost
  Esc  or  P        pause
  R                 retry

On a touch screen: throttle is automatic — you only choose where to go.
Drag anywhere on the left of the screen to steer; how far you pull from
where your thumb landed is how hard you turn. The right side of the screen
is a boost pad. No on-screen d-pad, and the middle of the screen stays
clear.
```

## Japanese one-liner

```
鬼ごっこ — ことばのいらない、ひとりで遊ぶブラウザゲーム。75秒、ふたりの鬼から逃げきろう。
```

## Privacy line (paste near the bottom of the description)

```
Your best score and settings are saved only in your browser. Nothing is
sent anywhere. The bin on the title screen deletes them.
```

---

## Recommended itch.io settings

These are recommendations from testing, not decisions. Every one of them is
yours to change.

| Field | Recommended | Why |
| --- | --- | --- |
| Kind of project | **HTML** | It is a static page; upload the zip with `index.html` at its root. |
| Embed | **Embed in page** | It is a short session in a fixed frame; it does not need its own tab. |
| Viewport | **960 × 600** | Tested. The title card is 432 px tall at 960 wide, so the frame needs about 480 px of height at minimum; 600 leaves comfortable headroom. |
| Fullscreen button | **ON** | The game fills whatever box it is given, and it reads much better big. |
| Mobile friendly | **OFF** for v0.1 | Phone **portrait** (390 × 844) is clean. Phone **landscape** (844 × 390) is not: the title card is 432 px tall and the bottom row of buttons is cut off by the viewport. Until that is fixed, leaving this off avoids handing phone players a screen they cannot finish reading. |
| Automatically start on page load | **OFF** | Audio needs a gesture to unlock in every browser, so an auto-start round would begin silent. |
| SharedArrayBuffer support | **OFF** | Not used. Turning it on adds cross-origin isolation headers the game does not need. |
| Pricing | **Free**, donations **off** | No commerce on this release. |
| Classification | **Games** | |
| Genre | **Action** | |
| Release status | **Released** | |
| Visibility | **Public** | Your call on timing. |

### Tag suggestions (pick up to 10)

```
tag, chase, arcade, short-session, wordless, no-text, 3d, singleplayer,
driving, kart
```

("one-button" is not accurate — steering and boost are separate inputs — so it
is left out.)

### Upload note

Upload `onigokko-v0.1.zip` as the project file and tick "This file will be
played in the browser". `index.html` is at the root of the archive, which is
what itch requires.
