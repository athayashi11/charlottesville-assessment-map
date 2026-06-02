"""
Replace street-geocoded coordinates in parcels.geojson with parcel polygon
centroids from Parcel_Boundary_Area.geojson.

For each assessment point, find the nearest boundary polygon via spatial join
and replace the point with that polygon's centroid.
"""

import json
import geopandas as gpd
from shapely.geometry import Point, mapping

BOUNDARIES = 'data/Parcel_Boundary_Area.geojson'
PARCELS    = 'data/parcels.geojson'
OUTPUT     = 'data/parcels.geojson'

# ── Load boundary polygons and compute centroids ───────────────────────────
UTM = 'EPSG:32618'   # UTM zone 18N — accurate for Charlottesville

print('Loading boundary polygons...')
bounds = gpd.read_file(BOUNDARIES)
bounds = bounds[bounds.geometry.notna()].copy()
bounds_utm = bounds.to_crs(UTM)
bounds['centroid_wgs84'] = bounds_utm.centroid.to_crs('EPSG:4326')
print(f'  {len(bounds)} boundary polygons loaded')

# Build a GeoDataFrame of centroids (in UTM) for the spatial join
centroids_gdf = gpd.GeoDataFrame(
    {'bnd_idx': bounds.index, 'centroid_wgs84': bounds['centroid_wgs84']},
    geometry=bounds_utm.centroid,
    crs=UTM,
)

# ── Load assessment parcels ────────────────────────────────────────────────
print('Loading assessment parcels...')
with open(PARCELS) as f:
    parcels_fc = json.load(f)

points_gdf = gpd.GeoDataFrame(
    {'feat_idx': range(len(parcels_fc['features']))},
    geometry=[
        Point(feat['geometry']['coordinates'])
        for feat in parcels_fc['features']
    ],
    crs='EPSG:4326',
).to_crs(UTM)
print(f'  {len(points_gdf)} assessment parcels loaded')

# ── Nearest-polygon spatial join ───────────────────────────────────────────
print('Joining each assessment point to its nearest boundary polygon...')
joined = gpd.sjoin_nearest(
    points_gdf,
    centroids_gdf,
    how='left',
    distance_col='dist_m',
)

# sjoin_nearest may produce duplicates if equidistant; keep first match
joined = joined[~joined.index.duplicated(keep='first')]

# ── Update coordinates in the original GeoJSON ────────────────────────────
print('Updating coordinates...')
matched = 0
unmatched = 0

for _, row in joined.iterrows():
    feat = parcels_fc['features'][row['feat_idx']]
    if row['bnd_idx'] is None or (hasattr(row['bnd_idx'], '__class__') and str(row['bnd_idx']) == 'nan'):
        unmatched += 1
        continue
    centroid = bounds.loc[row['bnd_idx'], 'centroid_wgs84']
    feat['geometry']['coordinates'] = [
        round(centroid.x, 7),
        round(centroid.y, 7),
    ]
    matched += 1

dist = joined['dist_m'].dropna()
print(f'  Matched: {matched}  |  Unmatched (coords unchanged): {unmatched}')
print(f'  Median match distance: {dist.median():.0f}m')
print(f'  90th pct match distance: {dist.quantile(0.90):.0f}m')
print(f'  Matches > 1km (likely bad geocodes): {(dist > 1000).sum()}')

# ── Write output ───────────────────────────────────────────────────────────
print(f'Writing {OUTPUT}...')
with open(OUTPUT, 'w') as f:
    json.dump(parcels_fc, f, separators=(',', ':'))

print('Done.')
