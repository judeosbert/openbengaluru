/* DashboardView (plan: review flow + dashboards) — the signed-in user's
 * submission dashboard: status chips, expandable detail (metadata, files,
 * comment thread + reply box), and the row actions: Open (expand/collapse,
 * same toggle as the title), View on map (active), Preview (own
 * pending/rejected/inactive with artifacts), Resubmit
 * (non-active — reopens the wizard prefilled, id pinned).
 *
 * Full-screen overlay panel over the map (SubmitFlow shell pattern); no
 * router. Data comes from the authed /api/submissions endpoints via
 * src/api.js; failures degrade to an honest inline message. */
import React from 'react';
import { fetchSubmissions, fetchSubmission, postComment } from '../api.js';
import { DATA_SOURCE_LABELS } from '../lib/submit.js';

const h = React.createElement;

const STATUS_LABEL = {
  pending: 'PENDING REVIEW',
  active: 'ACTIVE',
  rejected: 'REJECTED',
  inactive: 'INACTIVE',
};

/* Status chip — pending + !sim_ready is the pipeline-failure state ("SIMULATION
 * FAILED — resubmit to retry"), inactive + superseded_by says who replaced it. */
export function statusChip(sub) {
  let cls = sub.status;
  let text = STATUS_LABEL[sub.status] || sub.status;
  if (sub.status === 'pending' && !sub.sim_ready) {
    text = 'SIMULATION FAILED — resubmit to retry';
    cls = 'failed';
  }
  if (sub.status === 'inactive' && sub.superseded_by) {
    text += ' · superseded by ' + sub.superseded_by;
  }
  return h('span', { className: 'status-chip ' + cls }, text);
}

function fmtDay(ts) {
  const s = String(ts || '');
  return s.slice(0, 10);
}

export function DashboardView({ store }) {
  const [rows, setRows] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [openId, setOpenId] = React.useState(null);
  const [detail, setDetail] = React.useState(null);
  const [reply, setReply] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const loadRows = React.useCallback(() => {
    fetchSubmissions()
      .then((r) => setRows(r))
      .catch((e) => setError(String((e && e.message) || e)));
  }, []);

  React.useEffect(() => { loadRows(); }, [loadRows]);

  /* detail (files + comments) loads when a row expands */
  React.useEffect(() => {
    if (!openId) return undefined;
    let live = true;
    setDetail(null);
    fetchSubmission(openId)
      .then((d) => { if (live) setDetail(d); })
      .catch((e) => { if (live) setError(String((e && e.message) || e)); });
    return () => { live = false; };
  }, [openId]);

  const viewOnMap = (row) => {
    store.viewSim(row.id);
    store.setView('discover');
  };
  const preview = (row) => {
    store.previewSubmission(row.id, row.status);
    store.setView('discover');
  };
  const resubmit = (row) => {
    store.startResubmit(row);
    /* close the panel — the wizard renders whenever draftSub is set and
     * would sit underneath this overlay */
    store.setView('discover');
  };

  const sendReply = async (id) => {
    const text = reply.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await postComment(id, text);
      setReply('');
      setDetail(await fetchSubmission(id));
      loadRows();
    } catch (e) {
      setReply(text);
      setError('reply failed: ' + String((e && e.message) || e));
    } finally {
      setBusy(false);
    }
  };

  const renderDetail = (row) => [
    row.description ? h('div', { key: 'd', className: 'hint' },
      row.description) : null,
    h('div', { key: 'm', className: 'meta' },
      h('span', null, 'by ', h('b', null, row.author || '—')),
      h('span', null, 'submitted ', h('b', null, fmtDay(row.created_at))),
      h('span', null, 'demand ',
        h('b', null, row.demand == null ? '—' : row.demand)),
      h('span', null, 'peak served ',
        h('b', null, row.peak_served == null ? '—' : row.peak_served)),
      h('span', null, 'proposed net ',
        h('b', null, row.has_proposed ? 'yes' : 'no')),
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
      h('span', { className: 'when' }, fmtDay(c.created_at)),
      h('div', { className: 'body' }, c.body))),
      h('div', { key: 'rb', className: 'replybox' },
        h('input', { type: 'text', placeholder: 'Reply to the reviewers…',
          value: reply, onChange: (ev) => setReply(ev.target.value) }),
        h('button', { disabled: !reply.trim() || busy,
          onClick: () => sendReply(row.id) }, 'Send'))),
  ];

  const renderActions = (row) => {
    const out = [];
    out.push(h('button', { key: 'op', className: 'linkbtn',
      onClick: () => setOpenId(openId === row.id ? null : row.id) },
    'Open'));
    if (row.status === 'active') {
      out.push(h('button', { key: 'vm', className: 'linkbtn',
        onClick: () => viewOnMap(row) }, 'View on map'));
    }
    if (row.status !== 'active' && row.sim_ready) {
      out.push(h('button', { key: 'pv', className: 'linkbtn',
        onClick: () => preview(row) }, 'Preview'));
    }
    if (row.status !== 'active') {
      out.push(h('button', { key: 'rs', className: 'linkbtn',
        onClick: () => resubmit(row) }, 'Resubmit'));
    }
    return out;
  };

  return h('div', { className: 'dash-veil' },
    h('div', { className: 'dash' },
      h('div', { className: 'dash-head' },
        h('h3', null, 'MY SUBMISSIONS'),
        h('button', { className: 'ghost',
          onClick: () => store.setView('discover') }, 'Close')),
      error ? h('div', { className: 'reject' }, error) : null,
      rows === null && !error
        ? h('div', { className: 'hint' }, 'Loading…')
        : null,
      rows && rows.length === 0
        ? h('div', { className: 'hint' },
          'No submissions yet — "Submit a sim" starts the wizard.')
        : null,
      (rows || []).map((row) => h('div', { key: row.id,
        className: 'row-item' },
      h('div', { className: 'row-line' },
        h('button', { className: 'ghost row-title',
          onClick: () => setOpenId(openId === row.id ? null : row.id) },
          row.title),
        statusChip(row),
        typeof row.comment_count === 'number' && row.comment_count > 0
          ? h('span', { className: 'hint' },
            'comments: ' + row.comment_count)
          : null),
      openId === row.id
        ? h('div', { className: 'row-detail' }, renderDetail(row))
        : null,
      h('div', { className: 'row-actions' }, renderActions(row))))));
}