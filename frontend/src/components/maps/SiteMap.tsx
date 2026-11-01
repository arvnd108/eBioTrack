// Owner: B (Frontend)
// Purpose: Sampling sites map (Leaflet + OpenStreetMap)
//
// Import it with lazy(): Leaflet then loads only on pages that show a map.
// One circle per site, coloured by habitat; clicking it opens a popup with the site summary.
// The map fits the sites it is given; `selectedId` centres on one site and opens its popup.
// While `picking` is on, a click on the map reports its coordinates (for the site form).
// Tiles: OpenStreetMap (attribution required by its tile policy).

import 'leaflet/dist/leaflet.css';
import type { CircleMarker as LeafletCircleMarker } from 'leaflet';
import { useEffect, useRef, type ReactNode } from 'react';
import { CircleMarker, MapContainer, Popup, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import type { Site } from '../../types';
import { HABITAT_COLORS } from './habitatColors';

export interface SiteMapProps {
  sites: Site[];
  selectedId: number | null;
  onSelect: (siteId: number | null) => void;
  renderPopup: (site: Site) => ReactNode;
  picking?: boolean;
  picked?: { latitude: number; longitude: number } | null;
  onPick?: (latitude: number, longitude: number) => void;
}

/** India, where the seeded sites are; used when there is nothing to fit. */
const DEFAULT_CENTER: [number, number] = [22.5, 80];

function FitToSites({ sites, selectedId }: { sites: Site[]; selectedId: number | null }) {
  const map = useMap();
  // Refit only when the set of sites changes (filters, a new site), not when a popup opens or
  // closes, and not for a new array holding the same sites: the effect keys on this signature.
  const signature = sites.map((s) => `${s.site_id}:${s.latitude},${s.longitude}`).join('|');
  const latest = useRef({ sites, selectedId });
  latest.current = { sites, selectedId };
  useEffect(() => {
    const { sites, selectedId } = latest.current;
    if (selectedId !== null && sites.some((s) => s.site_id === selectedId)) return; // it decides
    if (sites.length === 0) map.setView(DEFAULT_CENTER, 4);
    else if (sites.length === 1) map.setView([sites[0].latitude, sites[0].longitude], 10);
    else
      map.fitBounds(
        sites.map((s) => [s.latitude, s.longitude]),
        { padding: [32, 32] },
      );
  }, [map, signature]);
  return null;
}

function PickOnClick({ onPick }: { onPick: (latitude: number, longitude: number) => void }) {
  useMapEvents({
    click: (event) =>
      onPick(Number(event.latlng.lat.toFixed(6)), Number(event.latlng.lng.toFixed(6))),
  });
  return null;
}

function SiteMarker({
  site,
  selected,
  onSelect,
  leaving,
  children,
}: {
  site: Site;
  selected: boolean;
  onSelect: (siteId: number | null) => void;
  /** True once the map is unmounting (see SiteMap). */
  leaving: { current: boolean };
  children: ReactNode;
}) {
  const ref = useRef<LeafletCircleMarker | null>(null);
  const map = useMap();
  useEffect(() => {
    if (!selected) return;
    map.setView([site.latitude, site.longitude], Math.max(map.getZoom(), 9));
    ref.current?.openPopup();
  }, [selected, map, site.latitude, site.longitude]);

  const color = HABITAT_COLORS[site.habitat_type];
  return (
    <CircleMarker
      ref={ref}
      center={[site.latitude, site.longitude]}
      radius={selected ? 11 : 8}
      pathOptions={{ color: '#ffffff', weight: 2, fillColor: color, fillOpacity: 0.9 }}
      eventHandlers={{
        click: () => onSelect(site.site_id),
        popupclose: () => {
          // Leaflet also closes the popup when the map is removed (leaving the page, for example
          // through a link in the popup); only a user closing it clears the selection.
          if (selected && !leaving.current) onSelect(null);
        },
      }}
    >
      <Popup>{children}</Popup>
    </CircleMarker>
  );
}

export default function SiteMap({
  sites,
  selectedId,
  onSelect,
  renderPopup,
  picking = false,
  picked = null,
  onPick,
}: SiteMapProps) {
  // React cleans up this component before the MapContainer inside it, so the flag is set
  // before Leaflet removes the map and its popup.
  const leaving = useRef(false);
  useEffect(() => {
    leaving.current = false;
    return () => {
      leaving.current = true;
    };
  }, []);
  return (
    <MapContainer
      center={DEFAULT_CENTER}
      zoom={4}
      scrollWheelZoom
      className={`h-[28rem] w-full rounded-lg border border-slate-200 ${picking ? 'cursor-crosshair' : ''}`}
    >
      <TileLayer
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        maxZoom={19}
      />
      <FitToSites sites={sites} selectedId={selectedId} />
      {sites.map((site) => (
        <SiteMarker
          key={site.site_id}
          site={site}
          selected={site.site_id === selectedId}
          onSelect={onSelect}
          leaving={leaving}
        >
          {renderPopup(site)}
        </SiteMarker>
      ))}
      {picking && onPick && <PickOnClick onPick={onPick} />}
      {picked && (
        <CircleMarker
          center={[picked.latitude, picked.longitude]}
          radius={7}
          pathOptions={{ color: '#047857', weight: 3, dashArray: '4 3', fillOpacity: 0.1 }}
        />
      )}
    </MapContainer>
  );
}
