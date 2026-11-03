# easyscreenshot

Give it a website. It picks the pages worth showing, hides the cookie banners and chat bubbles, and saves desktop, phone and full-page screenshots your coding agent can use.

```bash
npx easyscreenshot@latest linear.app
```

![The pages easyscreenshot picked on linear.app](.github/assets/linear-sheet.jpg)

A launch video, a Product Hunt gallery, a pitch deck or a README needs the product's real screens. Taking them by hand means opening each page, closing the cookie banner, waiting for the pictures, scrolling down and doing it all again on a phone, and an agent asked to do it either guesses the pages or draws the interface itself. easyscreenshot reads the site's own menu, picks the pages a visitor would look at first (pricing, features, how it works), and saves each one clean, with a manifest that tells your agent what is in every file.

## What you get

```
easyscreenshot-linear.app/
  SCREENSHOTS.md          every page: why it was picked, its files, the headings on its first screen
  manifest.json           the same, for scripts
  sheet.png               all pages on one picture, like the one above
  01-home-desktop.png     the first screen at 2x, 3200x1800
  01-home-mobile.png      the first screen on a phone, 1080x1920
  01-home-full.png        the whole page, 1600 wide
  02-pricing-desktop.png  and the same for every other page it picked
```

- Pages are picked from the home page's own menu, its big buttons and its footer, with the sitemap as a fallback. Each one says why it was picked, for example `menu link "Pricing"`.
- Sign-in pages, legal pages, careers, single blog posts and pages in another language are left out, and so is anything the site's robots.txt asks crawlers to stay out of. A page that only redirects to a sign-in page or to the home page, a bot check, and a second address for a page already taken are dropped too. The pages it left out are listed with the reason.
- Cookie and consent banners, chat bubbles, promo boxes and modal backdrops are hidden, never clicked: pressing "Accept" would give consent for you.
- Pictures that load late, sections that fade in on scroll, counters that count up and videos are there in full, on the first screen and on the whole page.
- Every heading on a first screen comes with its box in the image's own pixels, and every section of a whole page with where it starts and ends, so a crop or a zoom does not have to guess.
- Each PNG carries the address it came from, when it was taken and by what, in its own metadata.

## Use it with your agent

easyscreenshot ships as an [Agent Skill](https://agentskills.io). Install it once and your agent runs it by itself when it needs a product's real screens:

```bash
npx skills add EminBudak/easyscreenshot
```

That covers Claude Code, Codex, Cursor and the other agents the [`skills`](https://github.com/vercel-labs/skills) CLI supports. In Claude Code you can add it as a plugin instead:

```
/plugin marketplace add EminBudak/easyscreenshot
/plugin install easyscreenshot@easyscreenshot
```

In GitHub Copilot CLI it takes the same two steps:

```bash
copilot plugin marketplace add EminBudak/easyscreenshot
copilot plugin install easyscreenshot@easyscreenshot
```

Then ask as usual:

> Make Product Hunt gallery images for cal.com

The skill carries its own script, so it installs nothing else and needs no API key.

## Use it from the command line

```
npx easyscreenshot@latest <url> [options]

  --out <dir>       where to save (default: ./easyscreenshot-<host>)
  --pages <n>       how many pages, the home page included (default: 5, at most 12)
  --page <path>     take this page too, e.g. --page /pricing (repeat for more)
  --sizes <list>    desktop, mobile, iphone, full, mobile-full or WxH, each with
                    an optional @scale (default: desktop,mobile,full)
  --theme <name>    light, dark or both (default: light)
  --lang <code>     the site's version in this language, when it has one
  --hide <css>      hide one more element (repeat for more)
  --reduced-motion  ask the site for its reduced-motion version
  --no-clean        take the pages as they come, banners and bubbles included
  --json            print manifest.json instead of a summary
  --timeout <s>     give up after this many seconds (default: 300)
```

| Size | Window | Image | For |
| --- | --- | --- | --- |
| `desktop` | 1600x900 at 2x | 3200x1800 | slides, videos, README images; 16:9 |
| `mobile` | 360x640 at 3x | 1080x1920 | vertical video, Google Play; 9:16 |
| `iphone` | 440x956 at 3x | 1320x2868 | App Store frames (6.9") |
| `full` | the desktop's width at 1x | 1600 wide | the whole page, top to bottom |
| `mobile-full` | 360 wide at 2x | 720 wide | the whole phone page |
| `WxH@scale` | your own | | e.g. `1270x760@2` for a Product Hunt gallery, `1920x1080@1` for directory listings |

The phone sizes open the page as that phone's browser would, so a site that picks its mobile layout by the browser sends it. A whole page stops at 15,000 CSS pixels.

Some runs:

```bash
npx easyscreenshot@latest stripe.com --pages 3 --sizes desktop
npx easyscreenshot@latest cal.com --page /pricing --sizes 1270x760@2 --out gallery
npx easyscreenshot@latest yourapp.com --sizes iphone,mobile --theme both --out store
```

Installed globally (`npm install -g easyscreenshot`), the command is `easyscreenshot`. npx keeps the copy an earlier run fetched, so `npx easyscreenshot@latest` is how you get a newer version.

It needs Node 22 or newer and Chrome, Chromium, Edge or Brave. Set `CHROME_PATH` to pick the browser. There are no npm dependencies and nothing is downloaded: easyscreenshot drives the browser you already have over the Chrome DevTools Protocol, with a throwaway profile.

## How it works

1. Opens the home page in a headless browser on a 1600x900 desktop screen, scrolls to the bottom and back so lazy parts render, and reads its links: the menu (closed dropdowns too), the big buttons on the first screen, the body and the footer. It reads robots.txt and up to 500 addresses from the sitemap at the same time.
2. Gives each link a kind from its address and its words, in English, Turkish, German, French, Spanish and Portuguese: pricing first, then product and feature pages, how it works, enterprise, integrations and templates, the changelog, downloads, about, docs, customers and the blog. A link in the menu counts more than one in the footer, and an address only the sitemap knows counts less. The best page of each kind goes first.
3. Opens the candidates in that order and keeps a page only when it is a page of its own: not a redirect to a sign-in page or to the home page, not a bot check, not an error, and not the same page under another address (the same final address, canonical link or text).
4. On each page, hides what floats over it: everything fixed to the screen except the page's own top bar and sidebar, plus the consent and chat tools seen most (OneTrust, Cookiebot, Didomi, Usercentrics, Intercom, Crisp, Drift, HubSpot, Zendesk and more). When a consent dialog had stopped the page from scrolling, it lets the page scroll again.
5. Takes the first screen once its pictures, videos and fade-ins are done, and the whole page a screen at a time, each screen as the browser shows it, joined into one image with sticky headers and fixed bars shown once.
6. Opens every page again as a phone (or an iPhone, or in the dark theme) in windows of its own while it looks for the next pages.
7. Writes `manifest.json`, `SCREENSHOTS.md` and `sheet.png`.

## Limits

- A site that answers with a bot check gets no screenshots: easyscreenshot stops and says so, and does not try to get past it.
- Pages behind a login are not reached.
- A menu that only exists while the mouse is over it, and links made of buttons with no address, are not seen; the sitemap and `--page` fill in.
- A consent wall that blurs the page or loads nothing until you agree can not be hidden away.
- Dark captures use the site's own dark theme. A site without one looks the same in both.

## See also

- [easybrandkit](https://github.com/EminBudak/easybrandkit) saves a site's real logo files, colors and fonts as a brand kit.
- [launch-film](https://github.com/EminBudak/launch-film) turns a site into a short launch film, rendered on your machine.

## License

MIT
