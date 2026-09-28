const stages = [
  { id: 1, name: 'Patient & Document Intake Agent', detail: 'Collecting structured patient and insurance information' },
  { id: 2, name: 'Patient & Document Intake Agent', detail: 'Extracting clinical information from uploaded records' },
  { id: 3, name: 'Medical Information & Coding Agent', detail: 'Matching diagnoses and procedures with coding references' },
  { id: 4, name: 'Claim Validation & Workflow Agent', detail: 'Checking claim completeness and preparing review tasks' },
  { id: 5, name: 'Claim Generation Agent', detail: 'Creating a reviewable CMS-1500 claim draft' }
];

const defaultState = () => ({
  step: 1,
  files: [],
  extraction: '',
  codes: { icd: [{ code: 'J06.9', name: 'Acute upper respiratory infection, unspecified', confidence: 92, selected: true }], cpt: [{ code: '99213', name: 'Office or other outpatient visit, established patient', confidence: 88, selected: true }] },
  messages: [{ sender: 'agent', text: 'Welcome to MediClaim. I will collect the information needed for a claim, identify coding options, flag gaps, and prepare a CMS-1500 draft for your review.' }, { sender: 'agent', text: 'Start by completing the patient, insurance, and encounter details on the right.' }]
});

let state = loadState();
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let syncTimer;

async function request(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function createServerClaim() {
  if (state.backendClaimId) return;
  const claim = await request('/api/claims', { method: 'POST' });
  state.backendClaimId = claim.id;
  saveState();
  await syncClaim();
}

async function syncClaim() {
  if (!state.backendClaimId) return;
  await request(`/api/claims/${state.backendClaimId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: state.step, fields: formData(), codes: state.codes }) });
}

function scheduleSync() {
  window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => syncClaim().catch(() => {}), 350);
}

function loadState() { try { return { ...defaultState(), ...JSON.parse(localStorage.getItem('mediclaim-session')) }; } catch { return defaultState(); } }
function saveState() { localStorage.setItem('mediclaim-session', JSON.stringify(state)); }
function formData() { return Object.fromEntries(new FormData($('#claim-form')).entries()); }
function hydrateForm() { Object.entries(state.form || {}).forEach(([name, value]) => { const field = $(`[name="${name}"]`); if (field) field.value = value; }); }
function displayName() { const data = formData(); return [data.firstName, data.lastName].filter(Boolean).join(' ') || 'Untitled claim'; }
function addMessage(text, sender = 'agent') { state.messages.push({ text, sender }); saveState(); renderChat(); }
function setStep(step) { state.step = step; saveState(); render(); scheduleSync(); window.scrollTo({ top: 0, behavior: 'smooth' }); }

function renderChat() {
  const log = $('#chat-log'); log.innerHTML = '';
  state.messages.forEach(({ text, sender }) => { const node = $('#message-template').content.firstElementChild.cloneNode(true); node.classList.add(sender); node.querySelector('.bubble').textContent = text; log.append(node); });
  log.scrollTop = log.scrollHeight;
}

function renderProgress() {
  $$('.step').forEach((element) => { const number = Number(element.dataset.step); element.classList.toggle('active', number === state.step); element.classList.toggle('complete', number < state.step); });
  $('#progress-fill').style.width = `${(state.step - 1) * 25}%`;
  const stage = stages[state.step - 1];
  $('#agent-banner strong').textContent = stage.name;
  $('#agent-detail').textContent = stage.detail;
  $('#agent-banner .agent-icon').textContent = `0${stage.id}`;
  $('#claim-title').textContent = displayName();
}

function renderFiles() {
  const list = $('#file-list'); list.innerHTML = '';
  state.files.forEach((file, index) => { const chip = document.createElement('div'); chip.className = 'file-chip'; chip.innerHTML = `${escapeHtml(file.name)} <button type="button" data-file="${index}" aria-label="Remove file">×</button>`; list.append(chip); });
  list.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => { state.files.splice(Number(button.dataset.file), 1); saveState(); renderFiles(); }));
}

function renderCodes() {
  const draw = (target, codes) => { const root = $(target); root.innerHTML = ''; codes.forEach((item, index) => { const row = document.createElement('label'); row.className = 'code-row'; row.innerHTML = `<input type="checkbox" ${item.selected ? 'checked' : ''} data-index="${index}"><div><span class="code-name">${escapeHtml(item.code)} · ${escapeHtml(item.name)}</span><span class="code-description">Suggested from the encounter information</span></div><span class="confidence">${item.confidence}% match</span>`; root.append(row); }); root.querySelectorAll('input').forEach((input) => input.addEventListener('change', () => { codes[Number(input.dataset.index)].selected = input.checked; saveState(); })); };
  draw('#icd-codes', state.codes.icd); draw('#cpt-codes', state.codes.cpt);
}

function validationItems() {
  const data = formData();
  const activeCodes = [...state.codes.icd, ...state.codes.cpt].filter((code) => code.selected);
  return [
    { label: 'Patient identity', detail: data.firstName && data.lastName && data.dob ? 'Name and date of birth recorded' : 'Add full name and date of birth', pass: Boolean(data.firstName && data.lastName && data.dob) },
    { label: 'Insurance coverage', detail: data.payer && data.memberId ? 'Payer and member ID recorded' : 'Add payer and member ID', pass: Boolean(data.payer && data.memberId) },
    { label: 'Encounter details', detail: data.serviceDate && data.clinicalSummary ? 'Service date and clinical summary recorded' : 'Add service date and clinical summary', pass: Boolean(data.serviceDate && data.clinicalSummary) },
    { label: 'Code confirmation', detail: activeCodes.length ? `${activeCodes.length} confirmed code${activeCodes.length > 1 ? 's' : ''} ready for claim` : 'Confirm at least one diagnosis or procedure code', pass: Boolean(activeCodes.length) }
  ];
}

function renderValidation() {
  const checks = state.serverValidation?.checks || validationItems(); const root = $('#validation-grid'); root.innerHTML = '';
  checks.forEach((check) => { const item = document.createElement('div'); item.className = `check ${check.pass ? 'pass' : 'missing'}`; item.innerHTML = `<span>${check.pass ? '✓' : '!'}</span><div><strong>${check.label}</strong><small>${check.detail}</small></div>`; root.append(item); });
  const passed = checks.filter((item) => item.pass).length; const ready = state.serverValidation?.ready ?? passed === checks.length;
  $('#validation-badge').textContent = ready ? 'VALIDATED' : `${checks.length - passed} GAPS FOUND`;
  $('#validation-summary').className = `validation-summary ${ready ? '' : 'has-gaps'}`;
  $('#validation-summary').textContent = ready ? 'Claim is complete. A reviewer can now generate the CMS-1500 draft.' : `${passed} of ${checks.length} readiness checks passed. Complete the flagged information and run the check again.`;
  $('#continue-generation').disabled = !ready;
  $('#queue-count').textContent = ready ? '1' : '0';
}

function renderPreview() {
  const data = formData(); const codes = [...state.codes.icd, ...state.codes.cpt].filter((code) => code.selected);
  const diagnosis = state.codes.icd.filter((code) => code.selected).map((code) => code.code).join(', ') || '—';
  const procedureRows = state.codes.cpt.filter((code) => code.selected).map((code) => `<tr><td>${escapeHtml(code.code)}</td><td>${escapeHtml(code.name)}</td><td>${formatDate(data.serviceDate)}</td><td>${diagnosis}</td></tr>`).join('') || '<tr><td colspan="4">No procedure code selected</td></tr>';
  const costing = costingSummary(data);
  const costingMarkup = costing ? `<h4 class="costing-title">Costing factors · estimate for review</h4><table class="cms-table costing-table"><tbody><tr><th>Billed amount</th><td>${formatCurrency(costing.billed)}</td><th>Allowed amount</th><td>${formatCurrency(costing.allowed)}</td></tr><tr><th>Deductible applied</th><td>${formatCurrency(costing.deductible)}</td><th>Coinsurance</th><td>${formatCurrency(costing.coinsurance)} (${Number.isFinite(costing.coinsuranceRate) ? costing.coinsuranceRate : 0}%)</td></tr><tr><th>Copay</th><td>${formatCurrency(costing.copay)}</td><th>Estimated patient responsibility</th><td>${formatCurrency(costing.patient)}</td></tr><tr><th>Estimated payer responsibility</th><td>${formatCurrency(costing.payer)}</td><th>Estimated write-off</th><td>${formatCurrency(costing.writeOff)}</td></tr></tbody></table><p class="costing-note">Estimate only. Final patient responsibility and reimbursement are determined by the payer after adjudication.</p>` : '<p class="costing-note">No costing factors provided. Add optional amounts in the claim information panel to include an estimate.</p>';
  $('#claim-preview').innerHTML = `<div class="cms-header"><div><h3>CMS-1500 Health Insurance Claim Form</h3><p>DRAFT · FOR HUMAN REVIEW ONLY</p></div><p>MEDICLAIM · ${new Date().toLocaleDateString()}</p></div><div class="cms-grid"><div class="cms-cell wide"><span class="cms-label">1. Insurance plan / program name</span><span class="cms-value">${escapeHtml(data.payer || 'Not provided')}</span></div><div class="cms-cell"><span class="cms-label">1a. Insured's ID number</span><span class="cms-value">${escapeHtml(data.memberId || 'Not provided')}</span></div><div class="cms-cell"><span class="cms-label">2. Patient's name</span><span class="cms-value">${escapeHtml(displayName())}</span></div><div class="cms-cell"><span class="cms-label">3. Patient birth date</span><span class="cms-value">${formatDate(data.dob)}</span></div><div class="cms-cell"><span class="cms-label">11. Group number</span><span class="cms-value">${escapeHtml(data.groupNumber || 'Not provided')}</span></div><div class="cms-cell wide"><span class="cms-label">21. Diagnosis or nature of illness</span><span class="cms-value">${diagnosis}</span></div><div class="cms-cell"><span class="cms-label">24A. Date(s) of service</span><span class="cms-value">${formatDate(data.serviceDate)}</span></div></div><table class="cms-table"><thead><tr><th>Procedure</th><th>Description</th><th>Date of service</th><th>Diagnosis pointer</th></tr></thead><tbody>${procedureRows}</tbody></table><div class="cms-cell" style="margin-top:13px"><span class="cms-label">Clinical summary</span><span class="cms-value">${escapeHtml(data.clinicalSummary || 'Not provided')}</span></div>${costingMarkup}`;
}

function render() {
  renderProgress(); renderChat(); renderFiles(); renderCodes(); renderValidation(); renderPreview();
  const gates = { '#documents-stage': 2, '#coding-stage': 3, '#validation-stage': 4, '#generate-stage': 5 };
  Object.entries(gates).forEach(([selector, required]) => $(selector).classList.toggle('hidden', state.step < required));
}

async function addFiles(files) {
  const accepted = [...files].filter((file) => file.size <= 10 * 1024 * 1024); if (!accepted.length) return;
  state.files.push(...accepted.map((file) => ({ name: file.name, type: file.type, size: file.size }))); saveState(); renderFiles();
  const names = accepted.map((file) => file.name).join(', ');
  const data = formData();
  const extracted = data.clinicalSummary || 'Clinical information is ready to be reviewed. Confirm the suggested diagnosis and procedure codes before generating a claim.';
  state.extraction = extracted; saveState();
  if (state.backendClaimId) {
    try {
      const form = new FormData(); accepted.forEach((file) => form.append('files', file));
      const result = await request(`/api/claims/${state.backendClaimId}/documents`, { method: 'POST', body: form });
      if (result.extractedText) state.extraction = result.extractedText;
    } catch { addMessage('The files are stored in this browser session. Start the Python backend to enable server-side document extraction.'); }
  }
  $('#extraction-title').textContent = `${accepted.length} document${accepted.length > 1 ? 's' : ''} processed`;
  $('#extraction-copy').textContent = `Intake agent added ${names} to the session. Extracted context: ${extracted}`;
  $('#extraction').classList.remove('hidden');
  addMessage(`I added ${accepted.length} document${accepted.length > 1 ? 's' : ''} to this claim. I found clinical context that can help with the coding review.`);
}

function escapeHtml(value = '') { return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]); }
function formatDate(value) { return value ? new Date(`${value}T00:00:00`).toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }) : 'Not provided'; }
function formatCurrency(value) { return Number.isFinite(value) ? value.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : 'Not provided'; }
function costingSummary(data) {
  const parseOptional = (value) => value === '' || value == null ? NaN : Number(value);
  const billed = parseOptional(data.billedAmount);
  const allowedInput = parseOptional(data.allowedAmount);
  const deductibleInput = parseOptional(data.deductibleRemaining);
  const coinsuranceRate = parseOptional(data.coinsuranceRate);
  const copay = parseOptional(data.copay);
  const hasCosting = [billed, allowedInput, deductibleInput, coinsuranceRate, copay].some(Number.isFinite);
  if (!hasCosting) return null;
  const allowed = Number.isFinite(allowedInput) ? allowedInput : (Number.isFinite(billed) ? billed : 0);
  const deductible = Math.min(allowed, Number.isFinite(deductibleInput) ? deductibleInput : 0);
  const coinsurance = Math.max(0, allowed - deductible) * (Number.isFinite(coinsuranceRate) ? coinsuranceRate : 0) / 100;
  const patient = Math.min(allowed, deductible + coinsurance + (Number.isFinite(copay) ? copay : 0));
  return { billed, allowed, deductible, coinsuranceRate, coinsurance, copay, patient, payer: Math.max(0, allowed - patient), writeOff: Math.max(0, (Number.isFinite(billed) ? billed : allowed) - allowed) };
}

$('#claim-form').addEventListener('input', () => { state.form = formData(); state.serverValidation = null; saveState(); $('#claim-title').textContent = displayName(); scheduleSync(); });
$('#continue-intake').addEventListener('click', () => { const data = formData(); const missing = ['firstName', 'lastName', 'payer', 'memberId'].filter((key) => !data[key]); if (missing.length) { addMessage('I can continue, but the validation agent will later ask for the missing patient or insurance information. Add it now if available.'); } else { addMessage('Intake details saved. Please attach any clinical documents or continue with the coding suggestions.'); } setStep(2); });
$('#file-input').addEventListener('change', (event) => addFiles(event.target.files));
const dropZone = $('#drop-zone'); ['dragenter', 'dragover'].forEach((event) => dropZone.addEventListener(event, (item) => { item.preventDefault(); dropZone.style.borderColor = '#26779e'; })); ['dragleave', 'drop'].forEach((event) => dropZone.addEventListener(event, (item) => { item.preventDefault(); dropZone.style.borderColor = ''; })); dropZone.addEventListener('drop', (event) => addFiles(event.dataTransfer.files));
$('#continue-coding').addEventListener('click', async () => { try { await syncClaim(); const result = await request(`/api/claims/${state.backendClaimId}/coding-suggestions`, { method: 'POST' }); state.codes = result.codes; } catch { const summary = formData().clinicalSummary.toLowerCase(); if (summary.includes('diabetes')) state.codes.icd[0] = { code: 'E11.9', name: 'Type 2 diabetes mellitus without complications', confidence: 94, selected: true }; if (summary.includes('hypertension')) state.codes.icd[0] = { code: 'I10', name: 'Essential (primary) hypertension', confidence: 93, selected: true }; } saveState(); renderCodes(); addMessage('I prepared coding suggestions. Please confirm that they reflect the documented encounter before I validate the claim.'); setStep(3); });
$('#continue-validation').addEventListener('click', async () => { await syncClaim().catch(() => {}); try { state.serverValidation = await request(`/api/claims/${state.backendClaimId}/validate`, { method: 'POST' }); } catch { state.serverValidation = null; } saveState(); addMessage('I checked required data and confirmed codes. I will flag gaps rather than fill them in automatically.'); setStep(4); });
$('#rerun-validation').addEventListener('click', async () => { await syncClaim().catch(() => {}); try { state.serverValidation = await request(`/api/claims/${state.backendClaimId}/validate`, { method: 'POST' }); } catch { state.serverValidation = null; } saveState(); renderValidation(); addMessage('I reran the readiness check using the current claim information.'); });
$('#continue-generation').addEventListener('click', async () => {
  if ($('#continue-generation').disabled) return;
  let serverDraft = null;
  try {
    if (!state.backendClaimId) await createServerClaim();
    await syncClaim();
    serverDraft = await request(`/api/claims/${state.backendClaimId}/cms1500`);
  } catch (error) {
    // Keep the demo usable when the API is temporarily unavailable. The preview
    // is generated from the same reviewed browser state and can still be exported.
    state.cmsDraft = { localOnly: true, fields: formData(), codes: state.codes };
    addMessage('The server draft service was unavailable, so I created a local browser draft. You can still review and download it.');
  }
  if (serverDraft) state.cmsDraft = serverDraft;
  saveState();
  if (serverDraft) addMessage('The claim passed the readiness check. I created a CMS-1500 draft for your final review and export.');
  setStep(5);
});
$('#add-code').addEventListener('click', () => { const code = prompt('Enter an ICD-10 or CPT-4 code'); if (!code) return; const isCpt = /^\d{5}$/.test(code.trim()); state.codes[isCpt ? 'cpt' : 'icd'].push({ code: code.trim().toUpperCase(), name: 'User-added code — verify description', confidence: 100, selected: true }); state.serverValidation = null; saveState(); renderCodes(); scheduleSync(); });
$('#edit-claim').addEventListener('click', () => setStep(1));
$('#print-claim').addEventListener('click', () => window.print());
$('#download-claim').addEventListener('click', () => {
  const preview = $('#claim-preview').innerHTML;
  const documentHtml = `<!doctype html><html><head><meta charset="utf-8"><title>MediClaim CMS-1500 Draft</title><style>body{font-family:Arial,sans-serif;color:#183c59;margin:32px}.claim-preview{max-width:880px;margin:auto;border:1px solid #8aa2b6;padding:22px}.cms-header{border-bottom:2px solid #183d5e;display:flex;justify-content:space-between;padding-bottom:10px;align-items:flex-end}.cms-header h3{font-size:17px;margin:0}.cms-header p{margin:0;color:#526b80;font-size:10px}.cms-grid{display:grid;grid-template-columns:repeat(3,1fr);border-left:1px solid #b8c8d3;border-top:1px solid #b8c8d3;margin-top:13px}.cms-cell{border-right:1px solid #b8c8d3;border-bottom:1px solid #b8c8d3;min-height:60px;padding:7px}.cms-cell.wide{grid-column:span 2}.cms-label{display:block;color:#658096;font-size:8px;text-transform:uppercase;font-weight:700}.cms-value{display:block;color:#183c59;font-size:12px;margin-top:7px;font-weight:600}.cms-table{width:100%;border-collapse:collapse;margin-top:13px;font-size:11px}.cms-table th,.cms-table td{border:1px solid #b8c8d3;padding:7px;text-align:left}.cms-table th{font-size:8px;color:#638096;text-transform:uppercase}.costing-title{margin:18px 0 8px;font-size:12px;color:#183d5e}.costing-note{margin:8px 0;color:#718495;font-size:10px;font-style:italic}</style></head><body><div class="claim-preview">${preview}</div></body></html>`;
  const blob = new Blob([documentHtml], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `mediclaim-cms1500-${new Date().toISOString().slice(0, 10)}.html`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
});
$('#chat-form').addEventListener('submit', (event) => { event.preventDefault(); const input = $('#chat-input'); const message = input.value.trim(); if (!message) return; addMessage(message, 'user'); input.value = ''; window.setTimeout(() => { const replies = state.step < 3 ? 'I saved that note to this claim. Continue the guided steps when you are ready.' : 'I recorded your note. Please use the structured fields and confirmation controls before generating the final draft.'; addMessage(replies); }, 260); });
$('#clear-chat').addEventListener('click', () => { state.messages = [{ sender: 'agent', text: 'Conversation cleared. Your structured claim data remains saved.' }]; saveState(); renderChat(); });
$('#reset-claim').addEventListener('click', () => { if (confirm('Start a fresh claim? This clears the saved browser session.')) { state = defaultState(); localStorage.removeItem('mediclaim-session'); $('#claim-form').reset(); render(); } });
$('#new-claim').addEventListener('click', () => $('#reset-claim').click());
$$('.step').forEach((button) => button.addEventListener('click', () => { const target = Number(button.dataset.step); if (target <= state.step) setStep(target); }));
$$('.nav-link').forEach((button) => button.addEventListener('click', () => { $$('.nav-link').forEach((item) => item.classList.remove('active')); button.classList.add('active'); $$('.view').forEach((item) => item.classList.remove('active-view')); $(`#${button.dataset.view}-view`).classList.add('active-view'); }));
$$('.view-switch').forEach((button) => button.addEventListener('click', () => document.querySelector(`[data-view="${button.dataset.target}"]`).click()));

hydrateForm();
render();
createServerClaim().catch(() => {});
