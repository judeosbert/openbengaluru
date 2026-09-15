/* Submit wizard (3 steps; no anchor/rotation steps — the map auto-anchors:
 * geo-locked nets take placement from the parsed net bounds, so the
 * wizard never asks the user to place anything). A mandatory data-source
 * field documents provenance; the survey options require an http(s)
 * source link. The free-text username step is gone — the author comes
 * from the Google profile. */
import React from 'react';
import { MapProvider } from '../state/store.js';
import { ingestSlot } from '../lib/ingestSlot.js';
import {
  DATA_SOURCES, DATA_SOURCE_LABELS, validSourceUrl,
} from '../lib/submit.js';

const h = React.createElement;

export function SubmitFlow({ store }) {
  const d = store.draftSub;
  const [step, setStep] = React.useState(0);
  const [reject, setReject] = React.useState('');
  const [over, setOver] = React.useState(false);

  /* Slot upload: DEMAND takes exactly one .rou.xml, TODAY/PROPOSED NET take
   * exactly one .net.xml each. Wrong extension -> slot-specific rejection.
   * Re-uploading a slot replaces it. The raw file text is kept on the slot
   * record (`text`) — the server-submit flow POSTs it for the real SUMO run.
   * Classification + parsing live in the shared pure ingestSlot helper
   * (same core the resubmit prefill uses); only the DOM FileReader stays
   * here. */
  const addSlot = (slot, list) => {
    const arr = Array.from(list || []);
    if (!arr.length) return;
    const f = arr[arr.length - 1];
    if (typeof FileReader === 'undefined') {
      /* no DOM reader (test env): classify-only record, no text */
      const r = ingestSlot(slot, f.name, '');
      if (r.reject) { setReject(r.reject); return; }
      setReject('');
      store.updateDraft({ files: { ...(d.files || {}), [slot]: r.fileRecord } });
      return;
    }
    const rd = new FileReader();
    rd.onload = () => {
      const text = String(rd.result || '');
      const r = ingestSlot(slot, f.name, text);
      if (r.reject) { setReject(r.reject); return; }
      setReject('');
      store.updateDraft({ files: { ...(d.files || {}), [slot]: r.fileRecord } });
      if (slot === 'demand') {
        /* real demand count parsed in-browser; 0 elements -> warn but keep */
        const n = r.demandCount;
        store.updateDraft({ demandCount: n });
        if (n === 0) {
          setReject(f.name + ' — parsed 0 demand elements '
            + '(no <trip>/<vehicle>/<flow>); file kept, check your export');
        }
        return;
      }
      /* net slots: parse into draft.geo.<slot> for the live preview */
      if (r.geo) {
        store.setDraftGeo(slot, r.geo);
        /* geo-locked today net: anchor pre-filled from the downloaded
         * bounds (placement comes from the TODAY net — no manual step) */
        if (slot === 'today' && r.geo.geoLocked) {
          store.placeDraft(r.geo.anchor);
        }
      } else {
        setReject(f.name + ' — parsed 0 lanes (not a SUMO net?)');
      }
    };
    rd.readAsText(f);
  };

  const files = d.files || {};
  const surveySrc = d.dataSource === 'manual_survey'
    || d.dataSource === 'survey_data';
  const linkBad = surveySrc && !!d.sourceUrl && !validSourceUrl(d.sourceUrl);
  const canNext = [
    !!files.demand && !!files.today,
    d.title.trim().length > 0 && !!d.dataSource
      && (!surveySrc || validSourceUrl(d.sourceUrl)),
    true,
  ][step];

  let body = null;
  if (step === 0) {
    /* three individual slots: demand + today net required, proposed net
     * optional (skip = contribute without improving) */
    const slotDefs = [
      ['demand', 'DEMAND', '.rou.xml — trips/vehicles/flows, required, '
        + 'shared by both scenarios', 'route file'],
      ['today', 'TODAY NET', '.net.xml — required, sets the map placement',
        'network file'],
      ['proposed', 'PROPOSED NET',
        '.net.xml — optional, skip to contribute without improving',
        'network file'],
    ];
    const chip = (slot) => {
      const f = files[slot];
      return f
        ? h('span', { className: 'chip', key: 'c' + slot },
          h('b', null, slot.toUpperCase()),
          ' ' + f.name + ' · ' + (f.size / 1024).toFixed(1) + ' KB')
        : h('span', { className: 'chip', key: 'c' + slot },
          h('b', null, slot.toUpperCase()), ' — empty');
    };
    body = [
      h('h3', { key: 't' }, 'Upload the SUMO input set'),
      h('div', { key: 'h', className: 'hint' },
        'One demand (.rou.xml) plus the today net (.net.xml); a proposed '
        + 'net (.net.xml) is optional. Demand + net(s) is a complete SUMO '
        + 'input set — no .sumocfg needed.'),
      ...slotDefs.map(([slot, label, sub, accept]) => h('div', {
        key: slot, className: 'slot',
        onDragOver: (ev) => { ev.preventDefault(); setOver(slot); },
        onDragLeave: () => setOver(false),
        onDrop: (ev) => {
          ev.preventDefault();
          setOver(false);
          addSlot(slot, ev.dataTransfer.files);
        },
      }, [
        h('div', { key: 'l', className: 'slot-label' },
          h('b', null, label), h('span', { className: 'hint' }, sub)),
        h('input', {
          key: 'f', type: 'file', accept,
          onChange: (ev) => { addSlot(slot, ev.target.files); ev.target.value = ''; },
        }),
        over === slot ? h('div', { key: 'dz', className: 'dropzone over' },
          'drop ' + label.toLowerCase() + ' here') : null,
      ])),
      h('div', { key: 'c', className: 'chips' },
        slotDefs.map(([slot]) => chip(slot))),
      (files.demand || {}).name && typeof d.demandCount === 'number'
        ? h('div', { key: 'dc', className: 'hint' },
          'Parsed demand: ' + d.demandCount + ' vehicles (from '
          + files.demand.name + ')')
        : null,
      reject ? h('div', { key: 'r', className: 'reject' }, reject) : null,
    ];
  } else if (step === 1) {
    body = [
      h('h3', { key: 't' }, 'Name it'),
      h('input', {
        key: 'ti', type: 'text',
        placeholder: 'e.g. Kundalahalli peak U-turn ban', value: d.title,
        onChange: (ev) => store.updateDraft({ title: ev.target.value }),
      }),
      h('textarea', {
        key: 'ta', rows: 3, placeholder: 'What does this simulation show?',
        value: d.desc,
        onChange: (ev) => store.updateDraft({ desc: ev.target.value }),
      }),
      h('div', { key: 'ds', className: 'fld' },
        h('label', null, 'DATA SOURCE'),
        h('select', {
          value: d.dataSource || '',
          onChange: (ev) => store.updateDraft({
            dataSource: ev.target.value,
            ...(ev.target.value === 'approximation' ? { sourceUrl: '' } : {}),
          }),
        },
          h('option', { value: '' },
            'Choose — Manual survey / Survey data / Approximation'),
          DATA_SOURCES.map((v) => h('option', { key: v, value: v },
            DATA_SOURCE_LABELS[v]))),
        surveySrc
          ? h('input', {
            type: 'url',
            placeholder: 'https:// link to your survey / source data',
            value: d.sourceUrl || '',
            onChange: (ev) => store.updateDraft({ sourceUrl: ev.target.value }),
          })
          : null,
        linkBad
          ? h('div', { key: 'lb', className: 'reject' },
            'the source link must be an http(s) URL')
          : null),
    ];
  } else {
    body = [
      h('h3', { key: 't' }, 'Review'),
      h('div', { key: 'rv', className: 'review' }, [
        h('b', { key: 'a' }, 'AUTHOR'), h('span', { key: 'av' }, d.username),
        h('b', { key: 'f' }, 'DEMAND'),
        h('span', { key: 'fv' },
          files.demand ? files.demand.name + ' · ' + d.demandCount + ' veh' : '—'),
        h('b', { key: 'fn' }, 'TODAY NET'),
        h('span', { key: 'fnv' }, files.today ? files.today.name : '—'),
        h('b', { key: 'fp' }, 'PROPOSED NET'),
        h('span', { key: 'fpv' }, files.proposed ? files.proposed.name : '—'),
        h('b', { key: 't' }, 'TITLE'), h('span', { key: 'tv' }, d.title),
        h('b', { key: 'dsk' }, 'DATA SOURCE'),
        h('span', { key: 'dsv' },
          d.dataSource ? DATA_SOURCE_LABELS[d.dataSource] : '—'),
        h('b', { key: 'su' }, 'SOURCE LINK'),
        h('span', { key: 'suv' }, d.sourceUrl || '—'),
      ]),
      h('div', { key: 'h', className: 'hint' },
        'Submitting runs the real simulation, then your sim goes to the '
        + 'review queue — an admin activates it onto the public map.'),
      /* persistent inline submit error (file:// hint, expired sign-in,
       * server/network failure — server error text verbatim): the wizard
       * stays open with the draft intact and Submit stays retryable. */
      store.submitError
        ? h('div', { key: 'se', className: 'reject' }, store.submitError)
        : null,
    ];
  }

  return h('div', {
    className: 'modal-veil',
    onClick: (ev) => { if (ev.target === ev.currentTarget) store.cancelDraft(); },
  },
    h('div', { className: 'modal' },
      h('div', { className: 'step' },
        'SUBMIT A SIMULATION · STEP ' + (step + 1) + '/3'),
      h('div', { key: step, className: 'flip-step' }, body),
      h('div', { className: 'row' },
        h('button', { className: 'ghost', onClick: store.cancelDraft }, 'Cancel'),
        step > 0
          ? h('button', {
            className: 'ghost',
            onClick: () => setStep(step - 1),
          }, 'Back') : null,
        step < 2
          ? h('button', {
            disabled: !canNext, onClick: () => setStep(step + 1),
          }, 'Next')
          : h('button', {
            disabled: store.submitting, onClick: store.submitDraft,
          }, store.submitting ? 'Simulating…' : 'Submit for review'))));
}
