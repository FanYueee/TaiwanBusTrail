"""Extract the reference road graph from a local Geofabrik Taiwan OSM PBF.

Requires pyosmium: python3 -m pip install osmium
Usage: python3 scripts/extract-roads.py data/tdx/taiwan.osm.pbf
"""
import json
import os
import sys
from pathlib import Path
import osmium

repo = Path(__file__).resolve().parents[1]
root = (repo / os.environ.get("TCBUS_DATA_DIR", "data/tdx")).resolve()
shapes = json.loads((root / "shapes.json").read_text())
points = [p for shape in shapes.values() for p in shape.get("geometry") or []]
south = min(p["lat"] for p in points) - .015
north = max(p["lat"] for p in points) + .015
west = min(p["lon"] for p in points) - .015
east = max(p["lon"] for p in points) + .015
classes = set("motorway trunk primary secondary tertiary unclassified residential living_street service busway motorway_link trunk_link primary_link secondary_link tertiary_link road".split())
ways = []
stations = []

def station_kind(tags):
    if tags.get("amenity") == "bus_station":
        return "bus_station"
    if tags.get("railway") == "station":
        return "railway"
    if tags.get("public_transport") == "station":
        return "public_transport"
    return None

class Roads(osmium.SimpleHandler):
    def node(self, node):
        if not node.location.valid():
            return
        lat, lon = node.location.lat, node.location.lon
        if not (south <= lat <= north and west <= lon <= east):
            return
        tags = dict(node.tags)
        kind = station_kind(tags)
        if not kind:
            return
        stations.append({"id": node.id, "lat": lat, "lon": lon,
                         "name": tags.get("name", ""), "kind": kind})

    def way(self, way):
        tags = dict(way.tags)
        kind = station_kind(tags)
        if kind and all(n.location.valid() for n in way.nodes):
            nodes = list(way.nodes)
            if len(nodes) > 1 and nodes[0].ref == nodes[-1].ref:
                nodes.pop()
            if nodes and any(south <= n.lat <= north and west <= n.lon <= east for n in nodes):
                # Node and way IDs are separate OSM namespaces.
                stations.append({"id": -way.id,
                                 "lat": sum(n.lat for n in nodes) / len(nodes),
                                 "lon": sum(n.lon for n in nodes) / len(nodes),
                                 "name": tags.get("name", ""), "kind": kind})
        if tags.get("highway") not in classes or tags.get("area") == "yes":
            return
        # Missing nodes must not create an invented connection across a gap.
        if any(not n.location.valid() for n in way.nodes):
            return
        coords = [(n.ref, n.lat, n.lon) for n in way.nodes]
        if len(coords) < 2 or not any(south <= lat <= north and west <= lon <= east for _, lat, lon in coords):
            return
        ways.append({"id": way.id, "nodes": [p[0] for p in coords], "geometry": [{"lat": p[1], "lon": p[2]} for p in coords],
                     "tags": {k: v for k, v in tags.items() if k in ("highway", "name", "ref", "oneway", "junction", "bridge", "tunnel", "layer", "access", "motor_vehicle", "bus", "service")}})

Roads().apply_file(sys.argv[1], locations=True, idx="flex_mem")
target = root / "roads.json"
target.write_text(json.dumps({"source": "OpenStreetMap contributors / Geofabrik Taiwan", "license": "ODbL-1.0", "bounds": [south, west, north, east], "ways": ways, "stations": stations}, ensure_ascii=False, separators=(",", ":")))
print(f"Reference roads: {len(ways)} ways, {len(stations)} stations, {target.stat().st_size / 1048576:.1f} MB")
