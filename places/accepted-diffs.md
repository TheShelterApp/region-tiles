# Accepted lattice changes

`places/lattice.mjs diff` and `verify.mjs --previous` fail when more than 0.5 % of a tier's answers change between the
previous release and the candidate without a line here. One line per accepted change, as a list item with a code span
`tier old-key new-key` (a key may be `*`) and the reason, grouped by the release that accepts it. Only the candidate
release's own section counts.

`verify.mjs` check 8 (part parity) also fails on a lattice point where `core` alone shows a zone, a water over land,
another country or another part of the world than `core` + `detail`, unless its line `parity tier lat,lon core-key
full-key` (as `reports/part-parity.txt` prints it) is in the candidate's section.

## 1.0.0

The first release: there is no previous release to compare with.

### Part parity

`core` alone knows land only by the regions bundle's simplified country outlines (they part from the province outlines
by 1-5 km at borders and cut some coasts and islands off); `detail` adds the province outlines and the towns, which
decide there. These points answer differently for the seconds between the two parts' installs. Finer country outlines
in `core` would remove them (an owner decision: it changes the outlines the overlays share).

- `parity regional 72.7211,-102.4843 sea:1159116661 adm0:CAN`: land only by a province outline; core alone shows a water over land
- `parity regional 72.6556,75.1477 sea:1159119119 adm0:RUS`: land only by a province outline; core alone shows a water over land
- `parity regional 70.9247,178.8123 sea:1159116037 adm0:RUS`: land only by a province outline; core alone shows a water over land
- `parity regional 70.7815,56.6306 sea:1159115861 adm0:RUS`: land only by a province outline; core alone shows a water over land
- `parity regional 70.4158,-127.5464 sea:1159117223 adm0:CAN`: land only by a province outline; core alone shows a water over land
- `parity globe 69.8993,31.1415 region:westernEurope region:easternEurope`: the band measured to a province outline; core alone shows another part of the world
- `parity regional 69.8993,31.1415 adm0:NOR adm0:RUS`: the band measured to a province outline; core alone shows another country
- `parity regional 68.8708,-76.4050 sea:1159118111 adm0:CAN`: land only by a province outline; core alone shows a water over land
- `parity regional 64.8165,36.8948 sea:1159116395 adm0:RUS`: land only by a province outline; core alone shows a water over land
- `parity regional 56.2707,-134.6578 sea:1159115079 adm0:USA`: land only by a province outline; core alone shows a water over land
- `parity regional 54.1067,138.7119 sea:1159115541 adm0:RUS`: land only by a province outline; core alone shows a water over land
- `parity regional 52.2875,-131.4045 sea:1159115079 adm0:CAN`: land only by a province outline; core alone shows a water over land
- `parity regional 52.0651,32.0194 adm0:UKR adm0:RUS`: land only by a province outline; core alone shows another country
- `parity regional 51.5315,34.2555 adm0:UKR adm0:RUS`: land only by a province outline; core alone shows another country
- `parity globe 50.1863,47.5086 region:centralAsia region:easternEurope`: the outlines disagree (the province and the towns decide); core alone shows another part of the world
- `parity regional 50.1863,47.5086 adm0:KAZ adm0:RUS`: the outlines disagree (the province and the towns decide); core alone shows another country
- `parity regional 50.0647,38.0366 adm0:UKR adm0:RUS`: land only by a province outline; core alone shows another country
- `parity globe 49.9292,48.6267 region:centralAsia region:easternEurope`: land only by a province outline; core alone shows another part of the world
- `parity regional 49.9292,48.6267 adm0:KAZ adm0:RUS`: land only by a province outline; core alone shows another country
- `parity regional 49.5339,112.8580 adm0:MNG adm0:RUS`: land only by a province outline; core alone shows another country
- `parity globe 49.0787,87.3689 region:eastAsia region:centralAsia`: land only by a province outline; core alone shows another part of the world
- `parity regional 49.0787,87.3689 adm0:CHN adm0:RUS`: land only by a province outline; core alone shows another country
- `parity regional 49.0490,-94.9991 adm0:CAN adm0:USA`: the outlines disagree (the province and the towns decide); core alone shows another country
- `parity regional 47.5622,134.2013 adm0:CHN adm0:RUS`: the outlines disagree (the province and the towns decide); core alone shows another country
- `parity regional 46.5246,16.4917 adm0:HUN adm0:SVN`: the outlines disagree (the province and the towns decide); core alone shows another country
- `parity regional 43.8387,19.3179 adm0:SRB adm0:BIH`: land only by a province outline; core alone shows another country
- `parity globe 42.6930,44.9701 region:westernAsia region:easternEurope`: the outlines disagree (the province and the towns decide); core alone shows another part of the world
- `parity regional 42.6930,44.9701 adm0:GEO adm0:RUS`: the outlines disagree (the province and the towns decide); core alone shows another country
- `parity regional 37.9628,-75.6041 sea:1159117043 adm0:USA`: land only by a province outline; core alone shows a water over land
- `parity regional 37.6380,126.1350 adm0:KOR adm0:PRK`: the band measured to a province outline; core alone shows another country
- `parity regional 34.1755,7.6336 adm0:DZA adm0:TUN`: the outlines disagree (the province and the towns decide); core alone shows another country
- `parity regional 29.5333,-5.6580 adm0:DZA adm0:MAR`: the outlines disagree (the province and the towns decide); core alone shows another country
- `parity regional 27.2407,88.0067 adm0:NPL adm0:IND`: the outlines disagree (the province and the towns decide); core alone shows another country
- `parity regional 26.0242,-97.1252 adm0:MEX adm0:USA`: the band measured to a province outline; core alone shows another country
- `parity regional 23.7076,92.1140 adm0:IND adm0:BGD`: land only by a province outline; core alone shows another country
- `parity globe 22.6729,103.5582 region:eastAsia region:southEastAsia`: the outlines disagree (the province and the towns decide); core alone shows another part of the world
- `parity regional 22.6729,103.5582 adm0:CHN adm0:VNM`: the outlines disagree (the province and the towns decide); core alone shows another country
- `parity regional 13.4190,-11.8915 adm0:SEN adm0:MLI`: land only by a province outline; core alone shows another country
- `parity globe 9.5362,33.8851 region:tropicalAfrica region:northAfrica`: the outlines disagree (the province and the towns decide); core alone shows another part of the world
- `parity regional 9.5362,33.8851 adm0:SSD adm0:SDN`: the outlines disagree (the province and the towns decide); core alone shows another country
- `parity regional 6.7842,9.8403 adm0:NGA adm0:CMR`: the outlines disagree (the province and the towns decide); core alone shows another country
- `parity regional 0.9219,-65.5476 adm0:VEN adm0:BRA`: the outlines disagree (the province and the towns decide); core alone shows another country
- `parity regional 0.7179,-69.1656 adm0:COL adm0:BRA`: the outlines disagree (the province and the towns decide); core alone shows another country
- `parity regional -18.0008,20.6648 adm0:AGO adm0:NAM`: the outlines disagree (the province and the towns decide); core alone shows another country
