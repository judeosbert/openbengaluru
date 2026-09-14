/* AdminView (plan: review flow + dashboards) — the review queue: pending
 * submissions first, a status filter, all submissions with the dashboard
 * columns (demand / peak_served / has_proposed), and the review actions:
 * Play on map (authenticated preview), Activate (with an explicit supersede
 * picker listing the other ACTIVE DB-managed submissions — the 9 generated
 * base-bundle entries are not manageable and never appear), Reject
 * (comment required), Deactivate (active rows).
 *
 * Full-screen overlay panel over the map (SubmitFlow shell pattern); no
 * router. Admin-only visibility is decided by the store's `me` (GET
 * /api/me); the server enforces the same rule on every action. */
import React from 'react';
import {
  fetchSubmissions, fetchSubmission, postComment,
} from '../api.js';
import { statusChip } from './DashboardView.js';

import { DATA_SOURCE_LABELS } from '../lib/submit.js';

const h = React.createElement;

const FILTERS = ['all', 'pending', 'active', 'rejected', 'inactive'];

export function AdminView({ store }) {
  const [rows, setRows] = React.useState(null);
  const [filter, setFilter] = React.useState('all');
  const [error, setError] = React.useState(null);
  const [openId, setOpenId] = React.useState(null);
  const [detail, setDetail] = React.useState(null);
  const [comment, setComment] = React.useState('');
  const [rejectText, setRejectText] = React.useState('');
  const [supersede, setSupersede] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const loadRows = React.useCallback(() => {
    fetchSubmissions()
      .then((r) => setRows(r))
      .catch((e) => setError(String((e && e.message) || e)));
  }, []);

  React.useEffect(() => { loadRows(); }, [loadRows]);

  React.useEffect(() => {
    if (!openId) return undefined;
    let live = true;
    setDetail(null);
    setSupersede('');
    fetchSubmission(openId)
      .then((d) => { if (live) setDetail(d); })
      .catch((e) => { if (live) setError(String((e && e.message) || e)); });
    return () => { live = false; };
  }, [openId]);

  const shown = (rows || []).filter((r) => filter === 'all'
    || r.status === filter);
  /* active DB-managed submissions (supersede targets; excludes the open row) */
  const activeTargets = (rows || []).filter((r) => r.status === 'active'
    && r.id !== openId);

  const act = async (fn, ok) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (ok) ok();
      loadRows();
      if (openId) setDetail(await fetchSubmission(openId).catch(() => null));
    } catch (e) {
      setError(String((e && e.message) || e));
    } finally {
      setBusy(false);
    }
  };

  const activate = (row) => act(
    () => store.activateSim(row.id, supersede || undefined),
    () => setRejectText(''));
  const rejectRow = (row) => {
    const text = rejectText.trim();
    if (!text) return;
    act(() => store.rejectSim(row.id, text), () => setRejectText(''));
  };
  const deactivate = (row) => act(() => store.deactivateSim(row.id));
  const sendComment = async (id) => {
    const text = comment.trim();
    if (!text) return;
    setBusy(true);
    try {
      await postComment(id, text);
      setComment('');
      setDetail(await fetchSubmission(id));
      loadRows();
    } catch (e) {
      setError('comment failed: ' + String((e && e.message) || e));
    } finally {
      setBusy(false);
    }
  };
  const play = (row) => {
    store.previewSubmission(row.id, row.status);
    store.setView('discover');
  };

  const renderActions = (row) => {
    const out = [];
    if (row.sim_ready) {
      out.push(h('button', { key: 'play', className: 'ghost',
        onClick: () => play(row) }, 'Play on map'));
    }
    if ((row.status === 'pending' || row.status === 'inactive')
        && row.sim_ready) {
      out.push(h('select', { key: 'ss', className: 'supersede-picker',
        value: supersede, onChange: (ev) => setSupersede(ev.target.value) },
      h('option', { value: '' }, activeTargets.length
        ? 'supersede: none (add alongside)'
        : 'supersede: nothing active'),
      activeTargets.map((t) => h('option', {
        key: t.id, value: t.id }, t.title))));
      out.push(h('button', { key: 'ac', disabled: busy,
        onClick: () => activate(row) }, 'Activate'));
    }
    if (row.status === 'pending') {
      out.push(h('div', { key: 'rj', className: 'rejectrow' },
        h('input', { type: 'text',
          placeholder: 'Reject reason (required)…', value: rejectText,
          onChange: (ev) => setRejectText(ev.target.value) }),
        h('button', { className: 'ghost',
          disabled: !rejectText.trim() || busy,
          onClick: () => rejectRow(row) }, 'Reject')));
    }
    if (row.status === 'active') {
      out.push(h('button', { key: 'dc', className: 'ghost', disabled: busy,
        onClick: () => deactivate(row) }, 'Deactivate'));
    }
    return out;
  };

  const renderDetail = (row) => [
    row.description ? h('div', { key: 'd', className: 'hint' },
      row.description) : null,
    h('div', { key: 'm', className: 'meta' },
      h('span', null, 'by ', h('b', null, row.author || '—')),
      h('span', null, 'uid ', h('b', null, row.author_uid || '—')),
      h('span', null, 'submitted ',
        h('b', null, String(row.created_at).slice(0, 10))),
      row.data_source
        ? h('span', null, 'data source ',
          h('b', null, DATA_SOURCE_LABELS[row.data_source]
            || row.data_source))
        : null,
      row.source_url
        ? h('span', null, h('a', {
          href: row.source_url, target: '_blank', rel: 'noreferrer',
        }, 'source link'))
        : null,
      row.reviewed_by
        ? h('span', null, 'reviewed by ', h('b', null, row.reviewed_by))
        : null,
      row.superseded_by
        ? h('span', null, 'superseded by ', h('b', null, row.superseded_by))
        : null),
    detail && detail.submission && detail.submission.id === row.id
      ? h('div', { key: 'f', className: 'fld files' },
        h('label', null, 'FILES'),
        h('div', { className: 'filelist' },
          (detail.files || []).map((f) => h('div', {
            key: f, className: 'filerow' }, f))))
      : h('div', { key: 'fl', className: 'hint' }, 'Files…'),
    h('div', { key: 't', className: 'thread' },
      ((detail && detail.comments) || []).map((c) => h('div', {
        key: c.id, className: 'comment' + (c.is_admin ? ' admin' : '') },
      h('span', { className: 'who' }, c.author
        + (c.is_admin ? ' · admin' : '')),
      h('span', { className: 'when' }, String(c.created_at).slice(0, 10)),
      h('div', { className: 'body' }, c.body))),
      h('div', { key: 'cb', className: 'replybox' },
        h('input', { type: 'text', placeholder: 'Add a review comment…',
          value: comment, onChange: (ev) => setComment(ev.target.value) }),
        h('button', { disabled: !comment.trim() || busy,
          onClick: () => sendComment(row.id) }, 'Send'))),
    h('div', { key: 'act', className: 'row-actions' }, renderActions(row)),
  ];

  return h('div', { className: 'dash-veil' },
    h('div', { className: 'dash' },
      h('div', { className: 'dash-head' },
        h('h3', null, 'REVIEW QUEUE'),
        h('div', { className: 'filter' },
          FILTERS.map((f) => h('button', {
            key: f, className: f === filter ? 'on' : 'ghost',
            onClick: () => setFilter(f),
          }, f.toUpperCase())),
          h('button', { className: 'ghost',
            onClick: () => store.setView('discover') }, 'Close'))),
      error ? h('div', { className: 'reject' }, error) : null,
      rows === null && !error
        ? h('div', { className: 'hint' }, 'Loading…')
        : null,
      rows && shown.length === 0
        ? h('div', { className: 'hint' }, 'Nothing here.')
        : null,
      shown.map((row) => h('div', { key: row.id, className: 'row-item' },
        h('div', { className: 'row-line' },
          h('button', { className: 'ghost row-title',
            onClick: () => setOpenId(openId === row.id ? null : row.id) },
            row.title),
          statusChip(row),
          h('span', { className: 'meta-inline' },
            'demand ', h('b', null, row.demand == null ? '—' : row.demand),
            ' · peak ', h('b', null,
              row.peak_served == null ? '—' : row.peak_served),
            ' · proposed ', h('b', null, row.has_proposed ? 'yes' : 'no'),
            ' · comments ', h('b', null, row.comment_count)),
          !row.sim_ready && row.status === 'pending'
            ? h('span', { className: 'status-chip failed' },
              'PIPELINE FAILED — resubmit to retry') : null),
        openId === row.id
          ? h('div', { className: 'row-detail' }, renderDetail(row))
          : null))));
}