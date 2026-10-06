# Licenses & Attribution

This dataset combines multiple open sources. **Required attribution string** (also in `version.json`):

> Boundaries © geoBoundaries (CC-BY), Natural Earth.

Surface this in any app that displays the region overlays.

## Sources by level

- **ADM0 (countries):** Natural Earth 10m admin-0 — **public domain**. No attribution legally required; credited above by courtesy.
- **ADM1 (provinces/states):** Natural Earth 10m admin-1 — **public domain**.
- **ADM2 (districts):** geoBoundaries gbOpen ADM2 (per-country licenses below), with OpenStreetMap (**ODbL**) overrides for: ITA, DEU, FRA, ESP, PHL, BGD, ARE, RUS.

## OpenStreetMap override notice (ODbL)

ADM2 districts for **ITA, DEU, FRA, ESP, PHL, BGD, ARE, RUS** are derived from OpenStreetMap and are licensed under the **Open Database License (ODbL) 1.0**. © OpenStreetMap contributors. If you use these, you must credit OpenStreetMap and share adaptations of the data under ODbL. See https://www.openstreetmap.org/copyright .

## geoBoundaries ADM2 — per-country license (gbOpen)

geoBoundaries (https://www.geoboundaries.org) publishes each country under its own upstream license. Countries whose ADM2 was replaced by the OSM override above are governed by ODbL instead of the license shown here.

**CC0 1.0 Universal (CC0 1.0) Public Domain Dedication** (5)

CRI, ISR, NLD, PRT, SWE

**Creative Commons Attribution 2.5 Generic** (1)

ALB

**Creative Commons Attribution 3.0 Intergovernmental Organisations (CC BY 3.0 IGO)** (47)

ARG, ARM, BGD, BRA, BTN, COD, CPV, DJI, ECU, EGY, ERI, FSM, GIN, GTM, GUY, IDN, IRQ, KEN, LAO, LBR, LSO, MDG, MDV, MNG, MOZ, MRT, MWI, PER, PHL, PNG, PRK, SDN, SEN, SLB, SLE, SSD, SYR, TCD, THA, TLS, TZA, UZB, VNM, VUT, YEM, ZAF, ZWE

**Creative Commons Attribution 3.0 License** (7)

BLR, CAF, GAB, ITA, KOR, MYS, NER

**Creative Commons Attribution 4.0 (CC BY 4.0)** (13)

BFA, FJI, GMB, IRL, LCA, MEX, MMR, PLW, PRY, PSE, SOM, WSM, ZMB

**Creative Commons Attribution 4.0 International (CC BY 4.0)** (25)

AUS, CIV, CMR, COL, COM, DOM, GHA, GNQ, GRC, HND, ISL, KHM, LVA, MKD, MLI, NGA, NOR, NZL, PAN, QAT, ROU, RWA, SYC, TON, TUV

**Creative Commons Attribution-ShareAlike 2.0** (7)

AUT, HRV, JPN, SAU, TGO, TWN, XKX

**Creative Commons Attribution-ShareAlike 3.0 Unported** (5)

AZE, CYP, KGZ, TKM, URY

**Data license Germany - Attribution - Version 2.0** (1)

DEU

**Etalab Open License 2.0** (1)

FRA

**Federal Office of Topography swisstopo License** (1)

CHE

**National Institute of Statistics (INE) Data License** (1)

ESP

**Open Data Commons Open Database License 1.0** (33)

BEL, BHS, CHL, CUB, EST, ETH, FIN, GNB, HTI, HUN, IND, IRN, JAM, KAZ, KIR, KWT, LKA, LTU, LUX, MAR, MCO, NIC, POL, RUS, SRB, STP, SVK, SVN, SWZ, TJK, TUN, TUR, VEN

**Open Data Commons Public Domain Dedication and License (PDDL) v1.0** (1)

CHN

**Open Government Canada 2.0** (1)

CAN

**Open Government Licence v3.0** (1)

GBR

**Other - Direct Permission** (1)

OMN

**Public Domain** (28)

AFG, AGO, BDI, BEN, BGR, BIH, BLZ, BOL, BRN, BWA, COG, CZE, DNK, DZA, GEO, GUM, JOR, LBN, MNP, NAM, NPL, PAK, PRI, SLV, SUR, UGA, UKR, USA

**Singapore Open Data License Version 1.0** (1)

SGP

## Regenerating this file

Derived from the geoBoundaries ADM2 manifest (`gb_adm2_api.json`, boundaryLicense field). geoBoundaries citation:

> Runfola, D. et al. (2020) geoBoundaries: A global database of political administrative boundaries. PLoS ONE 15(4): e0231866.

## Area history statistics (`stats/`)

The earthquake counts and event lists under `stats/` are derived from the **USGS ANSS Comprehensive Earthquake Catalog
(ComCat)**, U.S. Geological Survey, Earthquake Hazards Program (https://earthquake.usgs.gov/data/comcat/, DOI
10.5066/F7MS3QZH) — a U.S. Government work in the **public domain**
(https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits). Credit line used by the app:

> Earthquake data: U.S. Geological Survey, ANSS Comprehensive Earthquake Catalog (ComCat).

Each event is assigned to a country with this dataset's ADM0 / ADM1 outlines (Natural Earth, public domain); see the
README, "Area history statistics".
