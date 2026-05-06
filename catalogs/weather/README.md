---
name: weather
version: 0.1.0
spec_version: v1
license: MIT
description: Weather block class — a $block subclass driven by an external plug that fetches tomorrow.io and pushes current, forecast, and history.
keywords:
  - block
  - weather
  - plug
  - demo
---

# weather

A `$weather_block` is a `$block` subclass that displays weather data
fetched by an external plug Worker. The plug authenticates as the block's
actor via an apikey credential, calls a hosted weather API on a schedule,
and pushes the result into the block's `writable_self` properties; the
block's owner configures *where* and *how* via `writable_owner` props.

See [DESIGN.md](DESIGN.md) for the mapping to canonical block kinds and
the plug's lifecycle.

## Properties

### Owner-writable (configuration)

| Name | Default | Notes |
|---|---|---|
| `place` | `""` | Town name or zip code. The plug passes this to the upstream API, and the block displays this same value. |
| `timezone` | `""` | IANA timezone, e.g. `America/Los_Angeles`; the plug uses it to write local observation time text. |
| `units` | `"metric"` | `"metric"` or `"imperial"`. |
| `forecast_hours` | `12` | How many hours of forecast the plug should fetch. |

### Plug-writable (data)

| Name | Kind | Notes |
|---|---|---|
| `current` | `scalar` | Headline current temperature with unit and label. |
| `forecast` | `series` | Hourly forecast with temperature points and hourly detail rows. |
| `history` | `series` | Recent observed values as a series. |
| `last_pushed_at` | int | Inherited from `$block`; epoch ms of last plug push. |
| `last_error` | str/null | Inherited from `$block`; most recent fetch failure. |

## Look Surface

`:title()` renders the current scalar reading directly, for example
`Temperature in Mountain View, CA: 72°F`. `:look_self()` renders a sentence:
`The weather panel shows that the temperature in Mountain View, CA was 72°F
at May 6, 2026, 9:01 AM PDT.` The plug formats this from the observation
timestamp and the block's `timezone`; `:look_self()` does not show the raw
`last_pushed_at` epoch.

## Provisioning

```text
@create_instance $weather_block as the_living_room_weather location: the_living_room
:set_property("place", "Mountain View, CA")
:set_property("timezone", "America/Los_Angeles")
:set_property("units", "imperial")
:mint_apikey("weather-cf-worker-prod")
# paste the resulting secret into wrangler secret put WOO_APIKEY
# wrangler deploy from catalogs/weather/plug
```

Validate the minted token before storing it:

```bash
export WOO_BASE_URL="https://woo.example.com"
export WOO_APIKEY="apikey:<id>:<secret>"

curl -fsS "$WOO_BASE_URL/api/auth" \
  -H "content-type: application/json" \
  --data "{\"token\":\"$WOO_APIKEY\"}"
```

The response should include `actor` equal to the weather block and
`token_class: "apikey"`. Use the full `apikey:<id>:<secret>` token;
`apikey:<secret>` is not the documented token form.

The plug Worker lives at [`plug/`](plug/). It runs on a Cloudflare cron
schedule (hourly) and uses the REST `/api/objects/<id>/calls/<verb>`
surface to push data via apikey-bound session.
