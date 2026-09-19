# Astral Forecast Engine

A single-file financial-astrology research terminal. Open `index.html` in a browser — there is no build step, no server, and no install. The ephemeris is inlined, so it works fully offline apart from the price feed.

---

## What it is

Twenty-four tabs of Vedic and Western financial-astrology analysis over a sub-arcsecond ephemeris (Astronomy Engine — VSOP87/ELP-2000, inlined). Three of those tabs are research engines rather than displays:

| Tab | What it does |
|---|---|
| **⟲ Backtesting** | Statistical swing-reversal research — finds every qualifying swing high/low, computes several hundred astro features per day, and measures which signatures actually precede reversals |
| **◎ Forecasting** | Replays the fitted model forward into a dated reversal calendar with a 0-100 Reversal Probability Score |
| **✦ Astral Forecast** | A rule engine over a technical-astrology rulebook — intraday (5-min), weekly and monthly, forward and backward |

The remaining tabs cover panchanga, Shar (latitude), Kranti (declination), transits, natal/intraday charts, Bhav Phal, Ashtakavarga, Vyapaar Ratna, KP planets, D1/D9 charts, the Sarvatobhadra Chakra, planetary latitude/longitude charts, 15-minute timing, Gann Sq9 and sector forecasts.

---

## The research engines

### ⟲ Backtesting — swing-reversal research

Pulls daily OHLC from Yahoo Finance, marks every swing that satisfies an explicit correction rule, then asks *why* each reversal happened.

**Swing rules** — the correction is measured on the leg that *follows* the pivot (a swing high ⇒ the decline into the next swing low):

| Instrument class | Short-term (minor) | Long-term (major) |
|---|---|---|
| Index / commodity | > 3% and < 10% | ≥ 10% |
| F&O stock | > 5% and < 15% | ≥ 15% |

Short-term and long-term pivots come from **two independent zig-zags** (run at the minor and major thresholds), so a 20% decline is never shredded into small legs and mis-filed.

**Pipeline:** fetch → detect swings → compute several hundred astro features for every calendar day (positions, Shar, Kranti, speed, retrograde/combust/cazimi, the full aspect matrix, Graha & Rashi Drishti, Graha Yuddha, nakshatra events, panchanga) → research each swing over a ±2-day window → measure every single event and every 2- and 3-event combination against the full-sample baseline → walk-forward validate out-of-sample.

**Statistics reported for every pattern:** precision, recall, lift, Wilson 95% CI, one-sided binomial p-value, Cohen's *h*, and independent-episode counts.

Three guards keep the statistics honest:

- **Episode counting.** Astro events are heavily autocorrelated — a conjunction live on 31 consecutive days is *one* observation, not 31. Every significance test and every weight is computed on independent episodes.
- **Near-constant filter.** An event present on more than a third of all days cannot time anything, so it is flagged and excluded from scoring.
- **Walk-forward.** Weights are fitted on the first 70% of history and applied blind to the last 30%. That number, not the in-sample fit, is what the UI leads with.

### ◎ Forecasting — future reversal calendar

Scores every future trading day against the fitted model. Each row is fully explainable: a **why?** button opens the counts behind it — which events are live, on which of the five research days, their historical precision, lift, p-value and weight, plus the strongest matching multi-event combination with its sample size.

The **Reversal Probability Score** is a ranking metric (percentile of the day's weighted astro load against the fitted history), and the calibration column shows what that RPS band actually delivered historically against the baseline.

### ✦ Astral Forecast — technical-astrology rule engine

Rebuilt against the updated edition of the rulebook: where it speaks it wins, and rules it is silent on are kept and labelled *prior edition* rather than dropped. Every rule carries a citation to its section, and a **Rule Audit** view lists the 75 entries of the book's own index with implemented / firing status and how each graded.

Rules written for one commodity (the Gold, Silver and Sugar configurations) count only for that commodity and never inside an index score. Weekly and monthly reads average several days of the period instead of scoring one Monday snapshot as the whole week. Every graded number sits next to the two trivial callers — always-bullish and always-neutral — and the score's derivation (bullish sum, bearish sum, median, z) is shown rather than hidden.

**Approaching turn dates** lists the next dated turning events (exact aspects the book calls turning points, stations, latitude and declination reversals) and labels a window Major/Minor Top/Bottom only from how that event type has actually lined up with swings on the chosen instrument, with the chance rate beside it.

Encoded: the full pair matrix (40 planet pairs × 7 sign-distance aspects, with each conditional qualifier evaluated rather than assumed), sign and degree tables, placement natures, the normal-speed table (Mand/Atichari), Shar, strong bullish/bearish permutations, Dwidwadash and Shadashtak by sign, day × nakshatra, Vargottam, Gandanta, Panchak, Sankranti, Khappar, Bhadra, D9 conjunctions, combustion and rise rules, Saturn shadow speed, the SBC Vedh table, the yearly cabinet, sector attribution, 137 numbered observations, and a chapter of pure price/time technical rules.

Three horizons, forward and backward:

- **Intraday** — the instrument's own session in 5-minute slots, scored on each instant's own sky including the rising sign at that slot
- **Daily** — the next sessions, one read per day
- **Weekly** — next 26 weeks
- **Monthly** — next 18 months

Weighting shifts by horizon: intraday leans on the Moon and lagna, monthly on Jupiter, Saturn, Herschel, Neptune, Pluto and the nodes.

The headline score is the period's deviation from the **rulebook's own median/MAD baseline**, not a raw sum. The rulebook is inherently net-bullish, so a raw sum would call nearly every period bullish; centring makes "HIGH BULLISH" mean *unusually bullish for this rulebook*, which is the only thing a relative rulebook can honestly claim.

The backward test grades the rulebook against real prices **section by section**, so you can see which parts carry the forecast and which do not. Technical rules read only completed bars plus the predicted bar's open — never the close they are graded against.

### ☉ Day Forecast and ⏱ 15-min Timing

Both now run on the same rulebook engine. Day Forecast shows the book's four stages (prophecies, contra prophecies, net, chart corroboration), tithi + weekday as a separate overriding verdict, per-index reads using the book's sector-lords table, and a ten-session strip ahead. Timing scores every 15-minute slot, and lists the exact instants inside the session when the Moon changes sign, nakshatra or pada, the tithi changes, or Bhadra starts and ends, under the instrument's own 5/15-minute bars. The older KP hora views are kept below, labelled as not from the book.

### ◭ Sector Forecast, ◔ Panchak, ⬡ SBC

Sectors are scored from the book's planet, sign, sector-lord and technology-lord tables, with vedh on a sign or nakshatra routed to its lord's sectors, and the sector calls are backtested on their constituents. Panchak uses exact start and end instants and real sunrise for its ghadi rules, shows the range and breakouts, and grades every past Panchak. The SBC grid follows the Tech-Astro rulebook wherever both books cover the same vedh rule and says which book each rule came from.

---

## Universe

The NSE F&O list (`F&o.csv`), Indian and global indices, US large caps and commodities.

**Prices.** NSE history is baked from Upstox into `data/nse/` by a GitHub Action after each close, and a second Action publishes the session in progress every 15 minutes. Every chart joins the two: the baked history plus today's bar from the live snapshot (F&O stocks take it from a delayed public quote board), marked *live, provisional* until the evening bake replaces it. Provisional bars are drawn but never graded. Gold, Silver, Copper, Crude, Natural Gas and the Dow, Nasdaq and S&P 500 are baked the same way from Yahoo Finance into `data/yahoo/` after each close (a server has no CORS problem, and the free browser relays can no longer carry a 26-year history). US single stocks still come from Yahoo through a public relay, which can be slow or rate-limited; a failed fetch is reported, never silently substituted.

Dates are shown as DD-MMM-YY (or DD-MMM where the year is obvious) everywhere, including chart axes.

---

## Running it

Open `index.html` directly, or serve it over HTTP — some browsers block the price-feed requests from `file://` origins, which serving avoids:

```bash
python -m http.server 8000
```

Because the app is a single static file, GitHub Pages can also serve it: **Settings → Pages → Source: Deploy from a branch → main / (root)**.

---

## Accuracy notes

The engines report what they find, including when they find nothing. Out-of-sample lift, direction accuracy and per-section hit rates are shown as measured, with under-powered samples flagged rather than rounded up. Where timing validates but direction does not, the UI says so and tells you to take direction from price.

This is a research and study tool, not investment advice.

## License

MIT — see [LICENSE](LICENSE).
