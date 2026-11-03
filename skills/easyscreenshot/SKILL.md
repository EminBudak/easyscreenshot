---
name: easyscreenshot
description: Take real screenshots of a product's website before you make anything that shows it, such as a launch video, store or Product Hunt images, a deck, a README, a landing page or a social post. Picks the pages worth showing (home, pricing, features and the like), hides cookie banners and chat bubbles, and saves desktop, phone and whole-page PNGs with a manifest. Use it whenever the user asks for screenshots of a site, or for work that needs the product's real screens, and you know its address.
---

# easyscreenshot

Screens an agent draws itself look fake at first glance: a menu the site does not have, a pricing table with made-up plans. easyscreenshot opens the real site in a headless browser, picks the pages worth showing, and saves them without the cookie banners and chat bubbles that float over them.

## Take them

```bash
node <skill>/scripts/easyscreenshot.js <url> --out screenshots/<name>
```

`<skill>` is this skill's folder. The script needs Node 22 or newer and Chrome, Chromium, Edge or Brave on the machine; it installs nothing and needs no API key. A run takes two or three minutes, up to five on a site with very long pages.

- It takes five pages by default, the home page first. Use `--pages 3` for fewer, and `--page /pricing` (once per page) for pages that must be there.
- By default each page comes as the desktop's first screen at 3200x1800, the phone's at 1080x1920 and the whole desktop page. `--sizes iphone` gives 1320x2868 for App Store frames, `--sizes 1270x760@2` a Product Hunt gallery image, and `mobile-full` the whole phone page.
- `--theme dark` (or `both`) takes the site's own dark theme, `--lang tr` its version in another language.

## Use them

1. Read `screenshots/<name>/SCREENSHOTS.md` before anything else. It lists every page with why it was picked, its files and sizes, and the headings on its first screen.
2. Show `sheet.png` to the user before you build on the screenshots. It has every page on one picture, so they can see at once that the right pages were taken.
3. Use the files as they are. Do not redraw, retype or tidy up the interface, and never invent a screen the site does not have.
4. Headings and sections come with boxes in each image's own pixels (in `manifest.json` and `SCREENSHOTS.md`). Use them to crop or zoom into one part of a page instead of guessing where it is.
5. Whole-page images are long. To show one part, cut the section you need from it; its `sections` say where each one starts and ends.
6. When a page you need is missing, run again with `--page <path>`. `manifest.json` lists the other pages it could have taken (`candidates`) and the ones it left out, with the reason (`skipped`).

## When it goes wrong

- A site that answers with a bot check gives no screenshots: easyscreenshot stops and says so. Ask the user for screenshots instead.
- Screens behind a login are not reached. Ask the user for them, or for a public page that shows the same thing.
- If something still covers a page, run again with `--hide '<css selector>'`. Slow sites can take `--timeout 600`.
- Never present a screenshot as the product's own when it did not come from easyscreenshot or from the user.
