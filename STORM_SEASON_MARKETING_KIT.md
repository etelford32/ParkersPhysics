# Storm-Season Fleet Assessment — marketing kit

Status: v1, 2026-10-15. Offer lives on `request-access.html#offer`; the proof
page is `sample-fleet-assessment.html`. Strategy: `ORBIT_MARGIN_ROADMAP.md`
("2026-10 revision").

**Every number below comes from `data/marketing/sample-fleet-assessment.json`**
(baked by `node scripts/build-sample-fleet-assessment.mjs`, gated by
`node tests/fleet-assessment.mjs`). If you re-bake, re-check the numbers here.
Never type a new number into copy without baking it first.

## Rules for every piece of copy

1. **No accuracy claim we haven't earned.** Don't say "our model beats
   NRLMSIS" or "2–5× better". The MHD hindcast gate has not cleared
   (roadmap principle 5). What we CAN say: storms cost real altitude, the
   standard model under-responds at storm onset (Feb 2022 shows it), and we
   score every forecast against the customer's own tracking data.
2. **The sample fleet is illustrative; the storms are real.** Say both.
3. **Storm penalties are lower bounds** (empirical density model). Say "at
   least" or "lower bound".
4. Lead with the operator's decision, not the physics.

## Headline numbers (from the bake)

| Claim | Number | Where it comes from |
|---|---|---|
| Extra altitude a 3U at 380 km loses in a Gannon week | **≥ 899 m** (674 m – 1.1 km with ±25 % B) | `fleet[SAMPLE-01].events.gannon.extraLossKm` |
| Same 3U, Feb-2022 storm | **≥ 202 m** | `…events.feb2022.extraLossKm` |
| Peak Gannon drag vs quiet, 575 km | **×5.0** | `fleet[SAMPLE-08].events.gannon.dragRatioPeak` |
| Lifetime lost to one Gannon storm | **2.6 – 3.9 days** per satellite | `…events.gannon.lifetimeLostDays` |
| NRLMSISE-00 + real Ap, drag rise at 210 km, first 48 h after the 3 Feb 2022 Starlink launch | **at most ×1.21** | `starlink.maxDragRatioFirst48h` |
| What SpaceX reported | **up to ×1.5**, up to 40 of 49 lost | SpaceX update, 8 Feb 2022 |

## Item 1 — Sample assessment (the proof page)

Link: `https://parkersphysics.com/sample-fleet-assessment`

One-liner: *"Here's the assessment we'd run on your fleet, done on an
8-satellite sample fleet with the real Feb-2022 and Gannon storm data."*

## Item 2 — Starlink, February 2022 (LinkedIn / blog post)

> On 3 Feb 2022, SpaceX released 49 Starlink satellites at about 210 km during
> a minor G1–G2 storm. SpaceX said drag ran up to 50% above previous launches,
> and up to 40 of the satellites reentered.
>
> We fed the real geomagnetic index for that week into NRLMSISE-00, the
> standard empirical density model. It predicts a drag rise of at most 21% in
> the first 48 hours.
>
> That gap is why we don't ask operators to trust a storm-time drag number.
> We forecast, then score the forecast against your own tracking data after
> every storm. Here's the full replay: [sample-fleet-assessment#starlink]

## Item 3 — Gannon on CubeSats (LinkedIn / outreach hook)

> The May 2024 Gannon superstorm, replayed on a 3U CubeSat at 380 km today:
> at least 899 m of extra altitude lost in one week, with drag peaking at 3–5×
> normal across 380–575 km.
>
> If you fly CubeSats below 600 km and don't have a flight-dynamics team,
> this is the analysis we run for your NORAD IDs for 90 days of storm season.
> [sample-fleet-assessment#gannon]

## Item 4 — Alerts and post-storm reports

The page shows an **example alert** and an **example post-storm report
layout** (marked as examples). The report's "your tracking" column is
deliberately empty; we fill it from the customer's data. Pitch line:

> *"After every storm you get a report comparing our forecast with your own
> tracking data, satellite by satellite, misses included."*

## Cold outreach email (CubeSat PI / NewSpace ops lead)

Subject: What the Gannon storm would cost {mission} today

> Hi {name},
>
> I run Parkers Physics, a space-weather drag forecasting group. We replayed
> the May 2024 Gannon storm on a sample CubeSat fleet: a 3U at 380 km loses at
> least 900 m of extra altitude in a single week.
> (https://parkersphysics.com/sample-fleet-assessment)
>
> For {mission}'s satellites at {altitude} km, we'd run the same analysis on
> your NORAD IDs and cover you through storm season: a decay outlook, an alert
> before each storm naming which satellites are exposed, and a post-storm
> report scoring our forecast against your own tracking data.
>
> It's a fixed-price, 90-day pilot ($3,000–$7,500 by fleet size). Would a
> 20-minute call next week be useful?
>
> Elliot

## Running it for a real prospect (before the call)

```bash
# on a networked machine (CelesTrak is blocked in the build sandbox)
for id in 12345 12346; do
  curl -s "https://celestrak.org/NORAD/elements/gp.php?CATNR=$id&FORMAT=TLE"
done > prospect.tle
node scripts/build-sample-fleet-assessment.mjs --tle prospect.tle --out prospect.json
```

B comes from the TLE B* (±35 %) until the prospect sends mass/area. Use
public results in a pitch only as *their* satellites' numbers, and only with
the same caveats.

## Leads

Form submissions from `request-access.html` go through `/api/contact/enterprise`
to `SALES_EMAIL`, whose code default is now `etelford32@gmail.com`. If the
Vercel project sets a `SALES_EMAIL` environment variable, that value wins —
check it in the Vercel dashboard.
