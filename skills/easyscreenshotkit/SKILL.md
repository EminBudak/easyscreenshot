---
name: easyscreenshotkit
description: Take real screenshots of a product's website before you make anything that shows it, such as a launch video, store or Product Hunt images, a deck, a README, a landing page, a social post or the screenshots of a web app manifest. Picks the pages worth showing (home, pricing, features and the like), hides cookie banners and chat bubbles, and saves desktop, phone and whole-page PNGs with a manifest. Also records a short demo video of the site (MP4 and GIF, with a pointer, smooth scrolling and a zoom on clicks), as a tour or from steps you write. Use it whenever the user asks for screenshots or a demo video of a site, or for work that needs the product's real screens, and you know its address.
---

# easyscreenshotkit

Screens an agent draws itself look fake at first glance: a menu the site does not have, a pricing table with made-up plans. easyscreenshotkit opens the real site in a headless browser, picks the pages worth showing, and saves them without the cookie banners and chat bubbles that float over them.

## Take them

```bash
node <skill>/scripts/easyscreenshotkit.js <url> --out screenshots/<name>
```

`<skill>` is this skill's folder. The script needs Node 22 or newer and Chrome, Chromium, Edge or Brave on the machine; it installs nothing and needs no API key. A run takes two or three minutes, up to five on a site with very long pages.

- It takes five pages by default, the home page first. Use `--pages 3` for fewer, and `--page /pricing` (once per page) for pages that must be there.
- By default each page comes as the desktop's first screen at 3200x1800, the phone's at 1080x1920 and the whole desktop page. `--sizes iphone` gives 1320x2868 for App Store frames, `--sizes 1270x760@2` a Product Hunt gallery image, and `mobile-full` the whole phone page.
- `--theme dark` (or `both`) takes the site's own dark theme, `--lang tr` its version in another language.
- `--pwa` also saves screenshots for a web app manifest in `pwa/`: first screens at 1920x1080 and 1080x1920, checked against Chrome's rules for its richer install dialog, with `pwa/manifest-screenshots.json` listing them. `--pwa-check <manifest file, its address or the site's>` checks the screenshots a manifest already has, with no browser.

## Use them

1. Read `screenshots/<name>/SCREENSHOTS.md` before anything else. It lists every page with why it was picked, its files and sizes, and the headings on its first screen.
2. Show `sheet.png` to the user before you build on the screenshots. It has every page on one picture, so they can see at once that the right pages were taken.
3. Use the files as they are. Do not redraw, retype or tidy up the interface, and never invent a screen the site does not have.
4. Headings and sections come with boxes in each image's own pixels (in `manifest.json` and `SCREENSHOTS.md`). Use them to crop or zoom into one part of a page instead of guessing where it is.
5. Whole-page images are long. To show one part, cut the section you need from it; its `sections` say where each one starts and ends.
6. When a page you need is missing, run again with `--page <path>`. `manifest.json` lists the other pages it could have taken (`candidates`) and the ones it left out, with the reason (`skipped`).
7. For a web app manifest, put `pwa/screenshots` next to the app's manifest and add the entries of `pwa/manifest-screenshots.json` to its `screenshots`. Each label is the main heading on that screen: read them, and change any that does not say what the screen shows. Then run `--pwa-check` on the manifest.

## Record a demo

When the user wants a demo video of the product, a GIF for a README, or footage of the real site for a launch video, record one:

```bash
node <skill>/scripts/easyscreenshotkit.js demo <url> --out demo/<name>
```

It needs ffmpeg on the machine as well. Without steps it takes a tour of the pages the screenshots would take, clicking through the site's own menu; `--pages 3` makes it shorter. A run takes two to four minutes.

For a flow the user describes (signing up, a search, a feature in use), write the steps to a file and pass `--steps demo.yaml`:

```yaml
url: https://acme.com
steps:
  - visit: /
  - click: "text=Pricing"
  - scroll: { to: "text=Compare plans" }
  - type: ada@example.com
    into: "input[name=email]"
  - key: Enter
  - wait: 1.5
```

The actions are visit, scroll, click, type, key, hover and wait. A target is a CSS selector or `text=` with the words on it; quote a selector that starts with `#`. Use only what is on the public site: a step behind a login fails.

What comes back:

1. `demo.mp4` (1920x1080, H.264), `demo.gif` (8 MB at most) and `poster.png`. Show the user the poster or the GIF before you build on the video.
2. `steps.json`: every step's start and end in seconds and in frames, and for a click the frame and the pixel where it lands. Time narration, captions, music cuts and click sounds from it instead of guessing.
3. After a tour, `demo.yaml` holds the steps it took. To change the tour (other pages, a longer pause, one more click), edit that file and record again with `--steps`.

## When it goes wrong

- A site that answers with a bot check gives no screenshots: easyscreenshotkit stops and says so. Ask the user for screenshots instead.
- Screens behind a login are not reached. Ask the user for them, or for a public page that shows the same thing.
- If something still covers a page, run again with `--hide '<css selector>'`. Slow sites can take `--timeout 600`.
- A demo step that points at nothing stops the run and names the step. Check the selector or the words against the page, or put a `wait` for it before the step.
- When the demo says ffmpeg is missing, ask the user to install it.
- Never present a screenshot as the product's own when it did not come from easyscreenshotkit or from the user.
