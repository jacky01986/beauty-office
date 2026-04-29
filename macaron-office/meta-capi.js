// meta-capi.js — Meta Conversions API client
// 送 server-side 事件（Lead/Purchase）到 Meta Pixel
// env: META_PIXEL_ID, META_CAPI_TOKEN, META_TEST_EVENT_CODE (optional, 測試用)
// 文檔: https://developers.facebook.com/docs/marketing-api/conversions-api

const crypto = require('crypto');

const PIXEL_ID = process.env.META_PIXEL_ID || '';
const CAPI_TOKEN = process.env.META_CAPI_TOKEN || '';
const TEST_EVENT_CODE = process.env.META_TEST_EVENT_CODE || '';
const API_VERSION = process.env.META_API_VERSION || 'v19.0';

function sha256(value) {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase(), 'utf8').digest('hex');
}

// 送單一事件到 Meta CAPI
async function sendEvent({ event_name, event_time, event_id, event_source_url, action_source = 'chat', user_data = {}, custom_data = {} } = {}) {
  if (!PIXEL_ID || !CAPI_TOKEN) {
    return { ok: false, reason: 'META_PIXEL_ID or META_CAPI_TOKEN not set' };
  }
  if (!event_name) return { ok: false, reason: 'event_name required' };

  const now = Math.floor(Date.now() / 1000);
  const eventTime = event_time || now;
  const eventId = event_id || (event_name + '_' + now + '_' + Math.random().toString(36).slice(2, 8));

  // Hash PII per Meta CAPI requirements
  const hashedUserData = {};
  if (user_data.email) hashedUserData.em = [sha256(user_data.email)];
  if (user_data.phone) hashedUserData.ph = [sha256(user_data.phone)];
  if (user_data.first_name) hashedUserData.fn = [sha256(user_data.first_name)];
  if (user_data.last_name) hashedUserData.ln = [sha256(user_data.last_name)];
  if (user_data.external_id) hashedUserData.external_id = [sha256(user_data.external_id)];
  // Non-hashed (allowed)
  if (user_data.client_ip_address) hashedUserData.client_ip_address = user_data.client_ip_address;
  if (user_data.client_user_agent) hashedUserData.client_user_agent = user_data.client_user_agent;
  if (user_data.fbc) hashedUserData.fbc = user_data.fbc;  // Facebook click ID
  if (user_data.fbp) hashedUserData.fbp = user_data.fbp;  // Facebook browser ID

  const eventPayload = {
    event_name,
    event_time: eventTime,
    event_id: eventId,
    action_source,  // 'chat' for messaging events
    user_data: hashedUserData,
  };
  if (event_source_url) eventPayload.event_source_url = event_source_url;
  if (custom_data && Object.keys(custom_data).length > 0) eventPayload.custom_data = custom_data;

  const body = { data: [eventPayload] };
  if (TEST_EVENT_CODE) body.test_event_code = TEST_EVENT_CODE;

  const url = 'https://graph.facebook.com/' + API_VERSION + '/' + PIXEL_ID + '/events?access_token=' + encodeURIComponent(CAPI_TOKEN);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await res.json();
    if (!res.ok || j.error) {
      console.error('[meta-capi] error:', j.error?.message || res.status, JSON.stringify(j).slice(0, 300));
      return { ok: false, reason: j.error?.message || ('HTTP ' + res.status), response: j };
    }
    return { ok: true, events_received: j.events_received, event_id: eventId, response: j };
  } catch (e) {
    console.error('[meta-capi] fetch failed:', e.message);
    return { ok: false, reason: e.message };
  }
}

// 客人首次傳訊息 → Lead 事件
async function sendLead({ contact_id, name, email, phone, source_channel, message_preview } = {}) {
  return sendEvent({
    event_name: 'Lead',
    user_data: {
      external_id: contact_id,
      email,
      phone,
      first_name: name,
    },
    custom_data: {
      lead_source: source_channel || 'salesmartly',
      content_name: 'customer_message',
      content_category: 'inbound_chat',
      preview: message_preview ? String(message_preview).slice(0, 100) : undefined,
    },
    action_source: 'chat',
  });
}

// 完成購買 → Purchase 事件
async function sendPurchase({ contact_id, email, phone, currency = 'TWD', value = 0, content_name, order_id } = {}) {
  return sendEvent({
    event_name: 'Purchase',
    event_id: order_id || undefined,
    user_data: { external_id: contact_id, email, phone },
    custom_data: { currency, value, content_name, order_id },
    action_source: 'business_messaging',
  });
}

// 跟客人聯絡 / 訊息回應 → Contact 事件
async function sendContact({ contact_id, name, email, phone } = {}) {
  return sendEvent({
    event_name: 'Contact',
    user_data: { external_id: contact_id, email, phone, first_name: name },
    custom_data: { content_name: 'inbound_message' },
    action_source: 'chat',
  });
}

module.exports = { sendEvent, sendLead, sendContact, sendPurchase, sha256 };
