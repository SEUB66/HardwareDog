/**
 * HARDWARE DOG / CAMERA SNIFFER / OBJECTS
 *
 * The guided physical inspection (a room, its objects, what was seen, the
 * next check, local photos) and the offline catalog of object families.
 * Built for a phone in one hand: big targets, one column, the camera at
 * hand. The priority orders the visit; it is never a probability, and an
 * object is never flagged for being in the catalog.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import {
  CATALOG,
  COMMS_LABEL,
  emptyFilter,
  family,
  filterFamilies,
  METHOD_LABEL,
  POWER_LABEL,
  ROOM_LABEL,
  type CatalogFilter,
  type Comms,
  type Family,
  type InspectMethod,
  type Power,
  type Room,
} from '../../core/camera/catalog';
import { ITEM_STATUSES, priorityWhy, STATUS_LABEL, type Annotation, type Item, type PhotoRecord, type RoomVisit } from '../../core/camera/inspection';
import type { Lab } from '../../core/lab/context';
import { instantOp } from '../../core/lab/events';
import { Panel } from '../components/Panel';
import { Tag } from '../components/Tag';

const ROOMS = CATALOG.rooms;

export function CameraObjects({ lab }: { lab: Lab }) {
  const insp = lab.camera.inspections;
  const cur = insp.current;
  const [place, setPlace] = useState(cur.place);
  const [roomKind, setRoomKind] = useState<Room>('bedroom');
  const [roomLabel, setRoomLabel] = useState('');
  const [sheet, setSheet] = useState<string | null>(null);
  const [addTo, setAddTo] = useState<string | null>(null);
  const ordered = insp.ordered();
  const openSheet = (id: string) => {
    setSheet(id);
    const f = family(id);
    // the companion compares with the sheet (read like a printout on the TV)
    if (f) instantOp(lab.bus, { source: 'CAMERA', tool: 'camera.compare', message: `reference sheet: ${f.name}`, kind: 'read', origin: 'PHYSICAL', params: { family: f.id } });
  };
  return (
    <>
      <Panel title="INSPECTION" info="Your visit: the rooms, the objects in them, what you saw, what is left to check. Kept in this browser only.">
        <div class="actions">
          <input class="input" placeholder="place (optional): rental, office, car…" value={place} onInput={(e) => setPlace((e.target as HTMLInputElement).value)} aria-label="Place inspected" />
          {cur.rooms.length === 0 ? (
            <button class="btn primary" onClick={() => insp.start(place)}>
              START AN INSPECTION
            </button>
          ) : (
            <button class="btn" onClick={() => confirm('Start a new inspection? The current one stays in this browser.') && insp.start(place)}>
              NEW INSPECTION
            </button>
          )}
        </div>
        <div class="actions">
          <select class="input" value={roomKind} onChange={(e) => setRoomKind((e.target as HTMLSelectElement).value as Room)} aria-label="Room type">
            {ROOMS.map((r) => (
              <option key={r} value={r}>
                {ROOM_LABEL[r]}
              </option>
            ))}
          </select>
          <input class="input" placeholder="name (optional): master bedroom…" value={roomLabel} onInput={(e) => setRoomLabel((e.target as HTMLInputElement).value)} aria-label="Room name" />
          <button
            class="btn"
            onClick={() => {
              insp.addRoom(roomKind, roomLabel);
              setRoomLabel('');
            }}
          >
            ADD ROOM
          </button>
        </div>
        {cur.rooms.length > 0 && (
          <div class="camera-rooms">
            {cur.rooms.map((r) => (
              <RoomCard key={r.id} lab={lab} room={r} onAdd={() => setAddTo(r.id)} onSheet={openSheet} />
            ))}
          </div>
        )}
        {cur.rooms.length > 0 && (
          <div class="actions">
            {cur.finished ? (
              <>
                <Tag status="PASS" label="FINISHED" />
                <button class="btn" onClick={() => insp.reopen()}>
                  REOPEN
                </button>
              </>
            ) : (
              <button class="btn" onClick={() => insp.finish()}>
                FINISH THE INSPECTION
              </button>
            )}
          </div>
        )}
      </Panel>
      {ordered.length > 0 && (
        <Panel title="VISIT ORDER" info="An aid to organise the visit, from what you said: a private room, an object facing a private space, a concrete observation to check. Never a probability of a camera.">
          <ol class="camera-order">
            {ordered.map(({ room, item, priority }) => (
              <li key={item.id}>
                <b>{item.label}</b> · {room.label || ROOM_LABEL[room.kind]} · {STATUS_LABEL[item.status]}
                {priority > 0 && <span class="dim"> · {priorityWhy(room, item).join(', ')}</span>}
              </li>
            ))}
          </ol>
        </Panel>
      )}
      <Catalog onSheet={openSheet} addTo={addTo} onAdd={(fid) => addTo && (insp.addItem(addTo, fid), setAddTo(null))} rooms={cur.rooms} onPickRoom={setAddTo} />
      {sheet && family(sheet) && <Sheet f={family(sheet)!} onClose={() => setSheet(null)} canAdd={cur.rooms.length > 0} onAdd={(roomId) => insp.addItem(roomId, sheet)} rooms={cur.rooms} />}
    </>
  );
}

function RoomCard({ lab, room, onAdd, onSheet }: { lab: Lab; room: RoomVisit; onAdd: () => void; onSheet: (id: string) => void }) {
  const insp = lab.camera.inspections;
  const [free, setFree] = useState('');
  return (
    <section class="camera-room" aria-label={room.label || ROOM_LABEL[room.kind]}>
      <header>
        <b>{room.label || ROOM_LABEL[room.kind]}</b> <span class="dim">{ROOM_LABEL[room.kind]}</span>
        <button class="btn small" onClick={() => confirm('Remove this room and its objects?') && insp.removeRoom(room.id)} aria-label="Remove room">
          ✕
        </button>
      </header>
      <div class="actions">
        <button class="btn" onClick={onAdd}>
          ADD FROM CATALOG
        </button>
        <input class="input" placeholder="another object…" value={free} onInput={(e) => setFree((e.target as HTMLInputElement).value)} aria-label="Object not in the catalog" />
        <button
          class="btn"
          disabled={!free.trim()}
          onClick={() => {
            insp.addItem(room.id, null, free);
            setFree('');
          }}
        >
          ADD
        </button>
      </div>
      {room.items.map((item) => (
        <ItemCard key={item.id} lab={lab} room={room} item={item} onSheet={onSheet} />
      ))}
    </section>
  );
}

function ItemCard({ lab, room, item, onSheet }: { lab: Lab; room: RoomVisit; item: Item; onSheet: (id: string) => void }) {
  const insp = lab.camera.inspections;
  const f = family(item.familyId);
  const [obs, setObs] = useState(item.observations);
  const [next, setNext] = useState(item.nextCheck);
  const [camera, setCamera] = useState(false);
  const save = () => (obs !== item.observations || next !== item.nextCheck) && insp.update(item.id, { observations: obs, nextCheck: next });
  return (
    <article class={`camera-item status-${item.status}`}>
      <header>
        <b>{item.label}</b>
        {item.where && <span class="dim"> · {item.where}</span>}
        {f && (
          <button class="linkish" onClick={() => onSheet(f.id)}>
            sheet: {f.name}
          </button>
        )}
        <button class="btn small" onClick={() => insp.removeItem(item.id)} aria-label={`Remove ${item.label}`}>
          ✕
        </button>
      </header>
      <div class="camera-item-grid">
        <label class="camera-field">
          Status
          <select class="input" value={item.status} onChange={(e) => (save(), insp.update(item.id, { status: (e.target as HTMLSelectElement).value as Item['status'] }))}>
            {ITEM_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label class="check">
          <input type="checkbox" checked={item.facesPrivate} onChange={(e) => insp.update(item.id, { facesPrivate: (e.target as HTMLInputElement).checked })} /> Faces a private space
        </label>
        <label class="check">
          <input type="checkbox" checked={item.concrete} onChange={(e) => insp.update(item.id, { concrete: (e.target as HTMLInputElement).checked })} /> A concrete observation to check
        </label>
      </div>
      {f && (
        <details class="camera-checks">
          <summary>What to look at ({f.observable.length}) · checks done: {item.checksDone.length}</summary>
          <ul>
            {f.observable.map((o) => (
              <li key={o}>{o}</li>
            ))}
          </ul>
          <p class="dim">Checks:</p>
          {f.checks.map((c) => (
            <label key={c} class="check">
              <input type="checkbox" checked={item.checksDone.includes(c)} onChange={(e) => insp.update(item.id, { checksDone: (e.target as HTMLInputElement).checked ? [...item.checksDone, c] : item.checksDone.filter((x) => x !== c) })} /> {c}
            </label>
          ))}
          <p class="note dim">A hole, a reflection or a dark part is never a verdict on its own: compare with the ordinary product.</p>
        </details>
      )}
      <label class="camera-field">
        What you saw
        <textarea class="input" rows={2} value={obs} onInput={(e) => setObs((e.target as HTMLTextAreaElement).value)} onBlur={save} />
      </label>
      <label class="camera-field">
        Next check
        <input class="input" value={next} onInput={(e) => setNext((e.target as HTMLInputElement).value)} onBlur={save} placeholder="compare the reference, ask the host…" />
      </label>
      <div class="actions">
        <button class="btn" onClick={() => setCamera(!camera)}>
          {camera ? 'CLOSE CAMERA' : 'PHOTO'}
        </button>
        <PhotoFile onFile={(b, w, h) => void insp.addPhoto(item.id, b, w, h)} />
      </div>
      {camera && <CameraCapture onShot={(b, w, h) => void insp.addPhoto(item.id, b, w, h)} />}
      {item.photos.length > 0 && (
        <div class="camera-photos">
          {item.photos.map((p) => (
            <Photo key={p} lab={lab} id={p} />
          ))}
        </div>
      )}
      <p class="dim small">{priorityWhy(room, item).length ? `organisation priority: ${priorityWhy(room, item).join(', ')}` : ''}</p>
    </article>
  );
}

/** A photo from a file (or the phone's own camera app): works where live video is refused. */
function PhotoFile({ onFile }: { onFile: (b: Blob, w: number, h: number) => void }) {
  return (
    <label class="btn file-btn">
      ADD A PHOTO FILE
      <input
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={async (e) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (!file) return;
          const dims = await imageSize(file).catch(() => ({ w: 0, h: 0 }));
          onFile(file, dims.w, dims.h);
          (e.target as HTMLInputElement).value = '';
        }}
      />
    </label>
  );
}

function imageSize(b: Blob): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(b);
    const img = new Image();
    img.onload = () => (resolve({ w: img.naturalWidth, h: img.naturalHeight }), URL.revokeObjectURL(url));
    img.onerror = () => (reject(new Error('not an image')), URL.revokeObjectURL(url));
    img.src = url;
  });
}

type TorchTrack = MediaStreamTrack;
/** Torch and zoom are not in every browser's types: read as optional. */
interface CamCaps {
  torch?: boolean;
  zoom?: { min: number; max: number; step: number };
}
const capsOf = (t: MediaStreamTrack | null | undefined): CamCaps => ((t && typeof t.getCapabilities === 'function' ? t.getCapabilities() : {}) as CamCaps);

/**
 * Live camera for the inspection: capture to this browser, zoom and torch
 * only when the camera says it has them. Not an infrared detector, not a
 * ToF sensor: a camera, to look closer and keep a picture.
 */
function CameraCapture({ onShot }: { onShot: (b: Blob, w: number, h: number) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [track, setTrack] = useState<TorchTrack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [torch, setTorch] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser offers no camera here (it needs a secure page and a camera). Use ADD A PHOTO FILE.');
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        if (video.current) video.current.srcObject = s;
        const t = s.getVideoTracks()[0] as TorchTrack | undefined;
        setTrack(t ?? null);
        const caps = capsOf(t);
        if (caps.zoom) setZoom(caps.zoom.min);
      })
      .catch((e: unknown) => setError(e instanceof Error && e.name === 'NotAllowedError' ? 'Camera permission refused. Photos can still be added from files.' : `Camera unavailable: ${e instanceof Error ? e.message : String(e)}`));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  const caps = capsOf(track);
  const setConstraint = (c: Record<string, unknown>) => void track?.applyConstraints({ advanced: [c as MediaTrackConstraintSet] }).catch(() => setError('The camera refused this setting.'));
  const shoot = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    c.toBlob((b) => b && onShot(b, c.width, c.height), 'image/jpeg', 0.85);
  };
  return (
    <div class="camera-capture">
      {error ? (
        <p class="note warn">{error}</p>
      ) : (
        <>
          <video ref={video} autoplay playsinline muted />
          <div class="actions">
            <button class="btn primary" onClick={shoot}>
              TAKE PHOTO
            </button>
            {caps.torch && (
              <button class={`btn${torch ? ' active' : ''}`} aria-pressed={torch} onClick={() => (setConstraint({ torch: !torch }), setTorch(!torch))}>
                TORCH
              </button>
            )}
            {caps.zoom && zoom !== null && (
              <label class="camera-field inline">
                ZOOM
                <input type="range" min={caps.zoom.min} max={caps.zoom.max} step={caps.zoom.step || 0.1} value={zoom} onInput={(e) => (setZoom(Number((e.target as HTMLInputElement).value)), setConstraint({ zoom: Number((e.target as HTMLInputElement).value) }))} />
              </label>
            )}
          </div>
          {!caps.torch && <p class="dim small">No torch control offered by this camera.</p>}
        </>
      )}
    </div>
  );
}

/** A photo with its numbered marks: tap to add one, with a note. */
function Photo({ lab, id }: { lab: Lab; id: string }) {
  const insp = lab.camera.inspections;
  const [rec, setRec] = useState<PhotoRecord | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let u: string | null = null;
    void insp.photos.get(id).then((r) => {
      if (!r) return;
      setRec(r);
      u = URL.createObjectURL(r.data);
      setUrl(u);
    });
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  }, [id]);
  if (!rec || !url) return null;
  const marks = rec.annotations;
  const save = (a: Annotation[]) => {
    setRec({ ...rec, annotations: a });
    void insp.annotate(id, a);
  };
  return (
    <figure class={`camera-photo${open ? ' open' : ''}`}>
      <div
        class="camera-photo-frame"
        onClick={(e) => {
          if (!open) return setOpen(true);
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          save([...marks, { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, note: '' }]);
        }}
      >
        <img src={url} alt={`inspection photo, ${new Date(rec.at).toLocaleString()}`} />
        {marks.map((m, i) => (
          <span key={i} class="camera-mark" style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%` }}>
            {i + 1}
          </span>
        ))}
      </div>
      {open && (
        <figcaption>
          <p class="dim small">Tap the photo to add a numbered mark. Kept in this browser.</p>
          {marks.map((m, i) => (
            <label key={i} class="camera-field">
              Mark {i + 1}
              <input class="input" value={m.note} onInput={(e) => save(marks.map((x, j) => (j === i ? { ...x, note: (e.target as HTMLInputElement).value } : x)))} />
            </label>
          ))}
          <div class="actions">
            <button class="btn" onClick={() => setOpen(false)}>
              CLOSE
            </button>
            <button class="btn" onClick={() => confirm('Delete this photo from this browser?') && void insp.removePhoto(id)}>
              DELETE PHOTO
            </button>
          </div>
        </figcaption>
      )}
    </figure>
  );
}

// ---------------------------------------------------------------- catalog

function Catalog({ onSheet, addTo, onAdd, rooms, onPickRoom }: { onSheet: (id: string) => void; addTo: string | null; onAdd: (familyId: string) => void; rooms: RoomVisit[]; onPickRoom: (id: string | null) => void }) {
  const [filter, setFilter] = useState<CatalogFilter>(emptyFilter());
  const list = filterFamilies(filter);
  const room = rooms.find((r) => r.id === addTo);
  const set = (patch: Partial<CatalogFilter>) => setFilter({ ...filter, ...patch });
  return (
    <Panel title="OBJECT CATALOG" info="Families of everyday objects in which cameras have been sold or documented. Offline, alphabetical, never ranked by frequency: there are no reliable statistics on what is found in rentals. Belonging to the catalog flags nothing.">
      {room && (
        <p class="note">
          Adding to <b>{room.label || ROOM_LABEL[room.kind]}</b>: pick a family.{' '}
          <button class="linkish" onClick={() => onPickRoom(null)}>
            cancel
          </button>
        </p>
      )}
      <div class="camera-filters">
        <input class="input" placeholder="search" value={filter.text} onInput={(e) => set({ text: (e.target as HTMLInputElement).value })} aria-label="Search the catalog" />
        <select class="input" value={filter.room ?? ''} onChange={(e) => set({ room: ((e.target as HTMLSelectElement).value || null) as Room | null })} aria-label="Room">
          <option value="">any room</option>
          {ROOMS.map((r) => (
            <option key={r} value={r}>
              {ROOM_LABEL[r]}
            </option>
          ))}
        </select>
        <select class="input" value={filter.power ?? ''} onChange={(e) => set({ power: ((e.target as HTMLSelectElement).value || null) as Power | null })} aria-label="Power">
          <option value="">any power</option>
          {(Object.keys(POWER_LABEL) as Power[]).map((p) => (
            <option key={p} value={p}>
              {POWER_LABEL[p]}
            </option>
          ))}
        </select>
        <select class="input" value={filter.comms ?? ''} onChange={(e) => set({ comms: ((e.target as HTMLSelectElement).value || null) as Comms | null })} aria-label="Documented communication">
          <option value="">any communication</option>
          {(Object.keys(COMMS_LABEL) as Comms[]).map((c) => (
            <option key={c} value={c}>
              {COMMS_LABEL[c]}
            </option>
          ))}
        </select>
        <select class="input" value={filter.method ?? ''} onChange={(e) => set({ method: ((e.target as HTMLSelectElement).value || null) as InspectMethod | null })} aria-label="Inspection method">
          <option value="">any method</option>
          {(Object.keys(METHOD_LABEL) as InspectMethod[]).map((m) => (
            <option key={m} value={m}>
              {METHOD_LABEL[m]}
            </option>
          ))}
        </select>
        <label class="check">
          <input type="checkbox" checked={filter.storage} onChange={(e) => set({ storage: (e.target as HTMLInputElement).checked })} /> local storage documented
        </label>
      </div>
      <div class="camera-families">
        {list.map((f) => (
          <div key={f.id} class="camera-family">
            <Illustration f={f} />
            <div>
              <b>{f.name}</b>
              <div class="dim small">
                {f.rooms.map((r) => ROOM_LABEL[r]).join(', ')} · {f.power.map((p) => POWER_LABEL[p]).join(' / ')}
              </div>
              <div class="actions">
                <button class="btn small" onClick={() => onSheet(f.id)}>
                  SHEET
                </button>
                {room && (
                  <button class="btn small primary" onClick={() => onAdd(f.id)}>
                    ADD HERE
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
        {list.length === 0 && <p class="note dim">No family matches these filters.</p>}
      </div>
      <p class="note dim">Catalog {CATALOG.version}. {CATALOG.note}</p>
    </Panel>
  );
}

/** A generic drawing for a family. Never a photo of a product, and labeled so. */
function Illustration({ f }: { f: Family }) {
  const initials = f.name
    .split(/[\s/]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  return (
    <svg class="camera-illu" viewBox="0 0 40 40" role="img" aria-label={`Generic illustration of a ${f.name.toLowerCase()}, not a product photo`}>
      <rect x="4" y="6" width="32" height="28" rx="4" fill="none" stroke="currentColor" stroke-width="2" />
      <circle cx="28" cy="13" r="2" fill="currentColor" opacity="0.6" />
      <text x="20" y="26" text-anchor="middle" font-size="11" font-family="monospace" fill="currentColor">
        {initials}
      </text>
    </svg>
  );
}

function Sheet({ f, onClose, canAdd, onAdd, rooms }: { f: Family; onClose: () => void; canAdd: boolean; onAdd: (roomId: string) => void; rooms: RoomVisit[] }) {
  const [roomId, setRoomId] = useState(rooms[0]?.id ?? '');
  return (
    <Panel title="REFERENCE SHEET" info="A family of objects: what can be observed, ordinary look-alikes, possible checks, scanner limits, and documented models with where and when they were seen.">
      <div class="camera-sheet-head">
        <Illustration f={f} />
        <div>
          <h3 class="camera-h3">{f.name}</h3>
          <p class="dim small">Generic illustration, not a product photo.</p>
          <p class="dim small">
            Rooms: {f.rooms.map((r) => ROOM_LABEL[r]).join(', ')} · power: {f.power.map((p) => POWER_LABEL[p]).join(', ')} · local storage: {f.storage === 'documented' ? 'documented in sold models' : 'unknown'} · communication: {f.comms.map((c) => COMMS_LABEL[c]).join(', ')}
          </p>
        </div>
        <button class="btn small" onClick={onClose} aria-label="Close the sheet">
          ✕
        </button>
      </div>
      <h4>Observable particularities</h4>
      <ul class="camera-list">
        {f.observable.map((o) => (
          <li key={o}>{o}</li>
        ))}
      </ul>
      <h4>Ordinary objects that look alike</h4>
      <ul class="camera-list">
        {f.lookalikes.map((o) => (
          <li key={o}>{o}</li>
        ))}
      </ul>
      <h4>Possible checks</h4>
      <ul class="camera-list">
        {f.checks.map((o) => (
          <li key={o}>{o}</li>
        ))}
      </ul>
      <h4>Scanner limits</h4>
      <p>{f.limits}</p>
      <h4>Documented models</h4>
      {f.models.length === 0 ? (
        <p class="note dim">No model documented for this family in this catalog version: to be completed. Nothing is shown rather than an unverified picture.</p>
      ) : (
        f.models.map((m) => (
          <div key={m.model} class="camera-model">
            <p>
              <b>
                {m.vendor} {m.model}
              </b>{' '}
              <Tag status={m.verified ? 'PASS' : 'UNKNOWN'} label={m.verified ? 'VERIFIED' : 'NOT VERIFIED'} />
            </p>
            <p class="dim small">
              {m.kind}: “{m.title}” · source: {m.source} · retrieved {m.retrieved}
            </p>
            <p class="small">{m.status}</p>
            <ul class="camera-list small">
              {m.claims.map((c) => (
                <li key={c}>{c} (vendor or retailer claim)</li>
              ))}
            </ul>
            <p class="small">Lens position: {m.lens}. Photo: {m.photo ? m.photo.credit : 'none (reuse rights not established)'}.</p>
          </div>
        ))
      )}
      {canAdd && (
        <div class="actions">
          <select class="input" value={roomId} onChange={(e) => setRoomId((e.target as HTMLSelectElement).value)} aria-label="Room">
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label || ROOM_LABEL[r.kind]}
              </option>
            ))}
          </select>
          <button class="btn" disabled={!roomId} onClick={() => onAdd(roomId)}>
            ADD TO THIS ROOM
          </button>
        </div>
      )}
    </Panel>
  );
}
