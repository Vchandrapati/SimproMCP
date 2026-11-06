# How past quotes were built

This is background from past quotes, not a set of rules. `SKILL.md` holds the rules. Nothing here has been validated by Complete AV, so use it to inform a question to the user, not to decide a price or structure yourself.

**Sample:** all 79 quotes with status "Quote: Won" among the 250 newest quotes on 6 November 2026 (IDs 12250–12507, issued from July 2026), plus the `SCS Service Template` quote (12404). The sample has 1,057 lines and is 36 quotes from one customer, Sydney Catholic Schools, so SCS patterns carry more weight. One large job (12381, $545,012) accounts for many of the unusual names and one-offs.

These numbers show what was done, not necessarily what should have been done. Won quotes can include one-off pricing decisions.

## Structure

| Measure | Result |
| --- | --- |
| Sections per quote | 1 section on 63, 2 on 10, 3 or more on 6 |
| Blank section names | 47 of 111 |
| Most common cost centres in a section | Equipment / Cables, Hardware and Fixings / Labour (37 sections) |
| Other common sets | Labour only (10), Equipment only (9), Service Call Out - Standard only (7), Equipment / Cables / Hardware and Fixings / Labour (5) |
| Cost centre types per quote | 1 type on 78 quotes, 2 on 1 |
| Cost centre type counts | Education - SCS 119, Corporate 96, Education - Other 17, Government 4, Box Sales 3, Service Calls 1, Warranty 0 |

## Materials

About 83% of the catalogue items sampled (188 of 226) have a 100% default markup. Only 52 of 335 lines in Equipment cost centres matched the item's default, compared with 233 of 293 in cable and hardware cost centres.

Real equipment lines, excluding freight, waste and items costing under $1:

| Group | Lines | Most common markups (lines) |
| --- | --- | --- |
| Education - SCS | 131 | 15% (51), 25% (23), 20% (17), 100% (13) |
| Corporate | 94 | 25% (35), 20% (25), 28% (11), 100% (6) |
| Education - Other | 27 | 15% (19), 25% (6) |
| Yealink | 28 | 25% (20), 22% (3) |
| Shure | 23 | 15% (8), 20% (8), 33% (4) |
| Crestron | 21 | 15% (13), 25% (4), 20% (3) |
| Q-SYS | 17 | 28% (10), 25% (3) |
| Promethean | 14 | 15% (6), then a spread |
| Q-Tee | 12 | 100% (9), 50% (3) |
| Epson | 12 | 15% (5), 20% (4) |
| Samsung | 10 | 25% (4), 17% (4), 20% (2) |
| Listen Technologies | 8 | 15% (8) |
| Blue Gum Joinery | 8 | 25% (7) |
| Logitech | 7 | 25% (5), 20% (2) |

Equipment under $100 had a median markup of 50%. Above that the median was 20%, with no clear change as cost rose.

Real cable and hardware lines: 100% (203), 50% (14), with the sampled 50% lines mostly Altronics.

One-offs: 37 lines, about 3.5% of all lines, and 10 of them are on quote 12381. Six had a cost of 0: an ex-demo item, a price increase, an admin fee, a parking line and two "supplied by others" notes.

No sampled line had a discount.

## Standard lines

| Item | Quotes or lines | Common sell prices | Placement (lines) |
| --- | --- | --- | --- |
| FIXINGS & TERMINALS | 57 lines | $100 (16), $45 (14), $50 (6) | Cables and hardware 56 |
| FREIGHT - BULKY | 30 lines | Varies, from a real cost | Equipment 24, Labour 5 |
| FREIGHT - MED | 20 lines | $30 (6), $50 (3) | Equipment 11, Labour 9 |
| WASTE MANAGEMENT | 20 lines | $10 (9) | Labour 14, Equipment 6 |
| E-WASTE | 13 lines | Varies, from a real cost | Equipment 12 |
| FREIGHT - SML | 10 lines | $40 (7) | Equipment 10 |
| RACK FIXINGS | 4 lines | $20–$150 | Cables and hardware 4 |

The default sell prices come from each item's catalogue cost and markup.

## Labour

Rates are Simpro's labour setup, a $90 cost rate plus a markup, and the quoted rates matched.

| Labour type | Lines | Sell rates seen | Median hours |
| --- | --- | --- | --- |
| AV Installer | 61 | $145 (61) | 8 |
| Project Management | 57 | $240 (57) | 1 |
| Commissioning Technician | 49 | $180 (48), $175 (1) | 4 |
| Project Documentation | 45 | $165 (45) | 2 |
| Programming | 13 | Lump sum, usually 33% markup (range 25–40%) | 1 |
| System Training | 6 | $150 (6) | 0.75 |
| Contractor | 5 | Lump sum, 13–30% markup | 1 |
| Stock Delivery | 1 | $135 | 4 |
| Rough-in - Technician | 1 | $145 | 12 |

Rack Build's $175 comes from the setup and wasn't seen in the sample.

Most common combinations: Installer + PM + Documentation (11), Commissioning only (8), Installer + PM (6), Installer + Commissioning + PM + Documentation (6).

## Service fees

| Fee | Lines | Prices seen |
| --- | --- | --- |
| PROJECT CALL OUT | 72 | $120 (71), $97.13 (1) |
| PARKING FEES | 26 | Corporate $100 (14 of 17), SCS $80 (6 of 7) |
| SCS Service Call Out | 11 | $325 (11) |
| SCS Emergency Call Out | 1 | $650 |
| Standard Service Call | 1 | $590 |

Project call outs were in a `Labour` cost centre on 61 of 72 lines. Quotes with call outs had a median of 8 site labour hours per call out. Parking qty equalled call out qty on all 14 quotes that had both.

## Not confirmed by the business

These were inferred from data and need someone to confirm them:

- Whether there's a real markup policy by customer type or brand.
- Any minimum margin or approval threshold.
- How to choose a freight size.
- Whether freight and waste should always sit in `Equipment`. The confirmed rule puts them at the bottom of `Equipment`, but past quotes also placed them in `Labour`.
- When Project Management and Documentation hours are required.
- When to use Government, Service Calls and Warranty.
- Whether builders working at SCS schools should always be Education - SCS.
