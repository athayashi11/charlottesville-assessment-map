To Do

1. Fix The coordinates for all Paynes Mill Rd parcels cluster at roughly lat 37.923, which is about 7 miles south of Charlottesville's center (38.033) — that's in Albemarle County. This is a geocoding error, not a data error.

Here's what happened:

The footer notes parcels were geocoded via the U.S. Census Bureau Geocoder. For "100 Paynes Mill Rd, Charlottesville, VA", the geocoder found the actual Paynes Mill Road (which physically exists in Albemarle County, south of the city) and placed the pin there. All 26 Paynes Mill Rd parcels are stacked at essentially the same coordinates in a suspiciously tight diagonal line — a dead giveaway that they were interpolated along a road segment rather than matched to real parcel centroids.

The underlying assessment records are legitimately City of Charlottesville parcels (they have Charlottesville city parcel IDs). The street simply straddles or abuts the city/county boundary, and the geocoder matched the address range to the county-side segment rather than within city limits.

The practical fix would be to manually correct those ~26 coordinates, or re-geocode them with a geocoder that has city boundary awareness (e.g., the Virginia GIS clearinghouse or Albemarle/Charlottesville's own parcel centroid files).

2. o	Neighborhood price index. I was unsure what the "(2000 = 100)" meant in the neighborhood price index graph. It would be great to have a little info icon or similar with a brief description.

3. Additional Information. It would great to have an info icon next to the measures to provide more info on what it is. 

Data export. It would be great to have the ability to export data, either for a specific property or for all. 

Sale AR. The AR at time of property sale would be incredibly useful. So perhaps a feature that shows all ARs at time of the property's sale (grey out parcels that haven't been sold that year or a map that shows the AR of the parcel's last sale). 

Change measures. If useful and not too much of an overhaul, it would be great to have a measure that shows the change in value from the prior year. 
