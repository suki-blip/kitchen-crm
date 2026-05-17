// Data access layer — Supabase client + entity helpers.
// All methods are async. Errors throw.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

// ----- Mappers (DB row → JS shape with nested objects) -----

const DEFAULT_SPEC = {
  kitchen: { layout:'', cabinets:'', finish:'', color:'', dimensions:'', notes:'' },
  stone:   { required: false, type:'', edge:'', notes:'' },
  handles:'', appliances:'', otherAccessories:'',
};

export function projectFromRow(r) {
  if (!r) return r;
  return {
    id:            r.id,
    customerId:    r.customer_id,
    address:       r.address || '',
    source:        r.source || '',
    assignedTo:    r.assigned_to,
    stage:         r.stage,
    trackingToken: r.tracking_token,
    quote: {
      amount:      r.quote_amount,
      sentAt:      r.quote_sent_at,
      validUntil:  r.quote_valid_until,
      approvedAt:  r.quote_approved_at,
    },
    deposit: {
      amount:      r.deposit_amount,
      receivedAt:  r.deposit_received_at,
    },
    spec:          r.spec || DEFAULT_SPEC,
    schedule: {
      productionStart: r.schedule_production_start,
      deliveryDate:    r.schedule_delivery_date,
      installDate:     r.schedule_install_date,
      stoneDate:       r.schedule_stone_date,
    },
    signedSpecAt:   r.signed_spec_at,
    subProducts:    r.sub_products || [],
    serviceTickets: r.service_tickets || [],
    createdAt:      r.created_at,
  };
}

// Patch object → DB row patch (flat snake_case). Pass only fields you want to update.
export function projectToPatch(patch) {
  const out = {};
  if ('customerId'    in patch) out.customer_id    = patch.customerId;
  if ('address'       in patch) out.address        = patch.address;
  if ('source'        in patch) out.source         = patch.source;
  if ('assignedTo'    in patch) out.assigned_to    = patch.assignedTo;
  if ('stage'         in patch) out.stage          = patch.stage;
  if ('signedSpecAt'  in patch) out.signed_spec_at = patch.signedSpecAt;
  if ('spec'          in patch) out.spec           = patch.spec;
  if ('subProducts'   in patch) out.sub_products   = patch.subProducts;
  if ('serviceTickets'in patch) out.service_tickets = patch.serviceTickets;
  if (patch.quote) {
    if ('amount'     in patch.quote) out.quote_amount       = patch.quote.amount;
    if ('sentAt'     in patch.quote) out.quote_sent_at      = patch.quote.sentAt;
    if ('validUntil' in patch.quote) out.quote_valid_until  = patch.quote.validUntil;
    if ('approvedAt' in patch.quote) out.quote_approved_at  = patch.quote.approvedAt;
  }
  if (patch.deposit) {
    if ('amount'     in patch.deposit) out.deposit_amount      = patch.deposit.amount;
    if ('receivedAt' in patch.deposit) out.deposit_received_at = patch.deposit.receivedAt;
  }
  if (patch.schedule) {
    if ('productionStart' in patch.schedule) out.schedule_production_start = patch.schedule.productionStart;
    if ('deliveryDate'    in patch.schedule) out.schedule_delivery_date    = patch.schedule.deliveryDate;
    if ('installDate'     in patch.schedule) out.schedule_install_date     = patch.schedule.installDate;
    if ('stoneDate'       in patch.schedule) out.schedule_stone_date       = patch.schedule.stoneDate;
  }
  return out;
}

export function taskFromRow(r) {
  if (!r) return r;
  return {
    id:          r.id,
    title:       r.title,
    projectId:   r.project_id,
    assignedTo:  r.assigned_to,
    dueDate:     r.due_date,
    priority:    r.priority || 'normal',
    completed:   !!r.completed,
    completedAt: r.completed_at,
    createdBy:   r.created_by,
    createdAt:   r.created_at,
  };
}

export function taskToPatch(patch) {
  const out = {};
  if ('title'       in patch) out.title        = patch.title;
  if ('projectId'   in patch) out.project_id   = patch.projectId;
  if ('assignedTo'  in patch) out.assigned_to  = patch.assignedTo;
  if ('dueDate'     in patch) out.due_date     = patch.dueDate;
  if ('priority'    in patch) out.priority     = patch.priority;
  if ('completed'   in patch) out.completed    = patch.completed;
  if ('completedAt' in patch) out.completed_at = patch.completedAt;
  return out;
}

export function customerFromRow(r) {
  if (!r) return r;
  return {
    id: r.id,
    name: r.name,
    phone: r.phone || '',
    email: r.email || '',
    generalAddress: r.general_address || '',
    notes: r.notes || '',
    createdAt: r.created_at,
  };
}

export function customerToPatch(patch) {
  const out = {};
  if ('name'           in patch) out.name             = patch.name;
  if ('phone'          in patch) out.phone            = patch.phone;
  if ('email'          in patch) out.email            = patch.email;
  if ('generalAddress' in patch) out.general_address  = patch.generalAddress;
  if ('notes'          in patch) out.notes            = patch.notes;
  return out;
}

export function profileFromRow(r) {
  if (!r) return r;
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    active: !!r.active,
    createdAt: r.created_at,
  };
}

// ----- Auth -----

export const auth = {
  async getSession() {
    const { data } = await supabase.auth.getSession();
    return data.session;
  },
  async getUser() {
    const { data } = await supabase.auth.getUser();
    return data.user;
  },
  async signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.session;
  },
  async signUp(email, password, name) {
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: { data: { name: name || email.split('@')[0] } },
    });
    if (error) throw error;
    return data;
  },
  async signOut() {
    await supabase.auth.signOut();
  },
  onChange(handler) {
    return supabase.auth.onAuthStateChange((event, session) => handler(event, session));
  },
};

// ----- Profiles -----

export const profiles = {
  async list() {
    const { data, error } = await supabase.from('profiles').select('*').order('name');
    if (error) throw error;
    return (data || []).map(profileFromRow);
  },
  async get(id) {
    const { data, error } = await supabase.from('profiles').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return profileFromRow(data);
  },
  async update(id, patch) {
    const { error } = await supabase.from('profiles').update(patch).eq('id', id);
    if (error) throw error;
  },
};

// ----- Customers -----

export const customers = {
  async list() {
    const { data, error } = await supabase.from('customers').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    return (data || []).map(customerFromRow);
  },
  async create(jsObj) {
    const { data, error } = await supabase.from('customers').insert(customerToPatch(jsObj)).select().single();
    if (error) throw error;
    return customerFromRow(data);
  },
  async update(id, patch) {
    const { error } = await supabase.from('customers').update(customerToPatch(patch)).eq('id', id);
    if (error) throw error;
  },
  async remove(id) {
    const { error } = await supabase.from('customers').delete().eq('id', id);
    if (error) throw error;
  },
};

// ----- Projects -----

export const projects = {
  async list() {
    const { data, error } = await supabase.from('projects').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    return (data || []).map(projectFromRow);
  },
  async create(jsObj) {
    const row = projectToPatch(jsObj);
    if (jsObj.customerId) row.customer_id = jsObj.customerId;
    const { data, error } = await supabase.from('projects').insert(row).select().single();
    if (error) throw error;
    return projectFromRow(data);
  },
  async update(id, patch) {
    const { error } = await supabase.from('projects').update(projectToPatch(patch)).eq('id', id);
    if (error) throw error;
  },
  async remove(id) {
    const { error } = await supabase.from('projects').delete().eq('id', id);
    if (error) throw error;
  },
};

// ----- Tasks -----

export const tasks = {
  async list() {
    const { data, error } = await supabase.from('tasks').select('*').order('due_date', { nullsFirst: false });
    if (error) throw error;
    return (data || []).map(taskFromRow);
  },
  async create(jsObj) {
    const { data, error } = await supabase.from('tasks').insert(taskToPatch(jsObj)).select().single();
    if (error) throw error;
    return taskFromRow(data);
  },
  async update(id, patch) {
    const { error } = await supabase.from('tasks').update(taskToPatch(patch)).eq('id', id);
    if (error) throw error;
  },
  async remove(id) {
    const { error } = await supabase.from('tasks').delete().eq('id', id);
    if (error) throw error;
  },
};

// ----- Files (links) -----

export const files = {
  async listForProject(projectId) {
    const { data, error } = await supabase.from('files').select('*').eq('project_id', projectId).order('added_at', { ascending: false });
    if (error) throw error;
    return data;
  },
  async create(row) {
    const { data, error } = await supabase.from('files').insert(row).select().single();
    if (error) throw error;
    return data;
  },
  async remove(id) {
    const { error } = await supabase.from('files').delete().eq('id', id);
    if (error) throw error;
  },
};

// ----- Activity log -----

export const activity = {
  async listForProject(projectId, limit = 200) {
    const { data, error } = await supabase
      .from('activity')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data;
  },
  async log(projectId, action) {
    const { error } = await supabase.from('activity').insert({ project_id: projectId, action });
    if (error) console.warn('activity log failed', error);
  },
};

// ----- Public tracking (anonymous, by token) -----

export const tracking = {
  async getProject(token) {
    const { data, error } = await supabase.rpc('get_project_by_token', { token });
    if (error) throw error;
    return data;
  },
  async submitTicket(token, issue) {
    const { data, error } = await supabase.rpc('submit_service_ticket', { token, issue });
    if (error) throw error;
    return data;
  },
  async approveSpec(token) {
    const { data, error } = await supabase.rpc('approve_spec_via_token', { token });
    if (error) throw error;
    return data;
  },
};

// ----- Task notes (timestamped log entries on a task) -----

export const taskNotes = {
  async listForTask(taskId) {
    const { data, error } = await supabase
      .from('task_notes')
      .select('*')
      .eq('task_id', taskId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  },
  async create(taskId, body) {
    const userId = (await supabase.auth.getUser()).data.user?.id;
    const { data, error } = await supabase
      .from('task_notes')
      .insert({ task_id: taskId, body, author_id: userId })
      .select()
      .single();
    if (error) throw error;
    return data;
  },
  async remove(id) {
    const { error } = await supabase.from('task_notes').delete().eq('id', id);
    if (error) throw error;
  },
};

// ----- Threads (internal team Q&A, supports group conversations) -----

export const threads = {
  // Fetch all threads where the current user is a participant — RLS handles filtering.
  // Each returned thread includes a `participants` array of user_ids (starter + recipients).
  async listMine() {
    const { data: rows, error } = await supabase
      .from('threads')
      .select('*')
      .order('last_message_at', { ascending: false });
    if (error) throw error;
    if (!rows?.length) return [];

    // Load participants for all visible threads in one round trip.
    const ids = rows.map(t => t.id);
    const { data: parts, error: pe } = await supabase
      .from('thread_participants')
      .select('thread_id, user_id')
      .in('thread_id', ids);
    if (pe) throw pe;

    const byThread = {};
    (parts || []).forEach(p => {
      (byThread[p.thread_id] ||= []).push(p.user_id);
    });
    return rows.map(t => ({ ...t, participants: byThread[t.id] || [] }));
  },
  async get(id) {
    const { data, error } = await supabase.from('threads').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const { data: parts } = await supabase
      .from('thread_participants').select('user_id').eq('thread_id', id);
    return { ...data, participants: (parts || []).map(p => p.user_id) };
  },
  // Create a thread with one or more recipients. The starter is added too.
  async create({ recipientIds, projectId, customerId, subject, urgency, body, attachmentUrl, attachmentKind, attachmentLabel }) {
    const userId = (await supabase.auth.getUser()).data.user?.id;
    const ids = (recipientIds || []).filter(Boolean);
    if (ids.length === 0) throw new Error('Pick at least one recipient');

    // 1) Create the thread row. recipient_id stores the "primary" (first) for backward compat.
    const { data: thread, error: e1 } = await supabase
      .from('threads')
      .insert({
        starter_id: userId,
        recipient_id: ids[0],
        project_id: projectId || null,
        customer_id: customerId || null,
        subject: subject || null,
        urgency: urgency || 'normal',
      })
      .select()
      .single();
    if (e1) throw e1;

    // 2) Add all participants (starter + recipients). Conflict-safe via PRIMARY KEY (thread_id, user_id).
    const participants = Array.from(new Set([userId, ...ids])).map(uid => ({
      thread_id: thread.id,
      user_id: uid,
    }));
    const { error: e2 } = await supabase.from('thread_participants').insert(participants);
    if (e2 && e2.code !== '23505') throw e2; // ignore duplicate-pk

    // 3) Post the first message.
    const { error: e3 } = await supabase.from('thread_messages').insert({
      thread_id: thread.id,
      author_id: userId,
      body,
      attachment_url: attachmentUrl || null,
      attachment_kind: attachmentKind || null,
      attachment_label: attachmentLabel || null,
    });
    if (e3) throw e3;

    return { ...thread, participants: participants.map(p => p.user_id) };
  },
  async close(id) {
    const { error } = await supabase
      .from('threads')
      .update({ status: 'closed', closed_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  },
  async reopen(id) {
    const { error } = await supabase
      .from('threads')
      .update({ status: 'open', closed_at: null })
      .eq('id', id);
    if (error) throw error;
  },
  async setUrgency(id, urgency) {
    const { error } = await supabase.from('threads').update({ urgency }).eq('id', id);
    if (error) throw error;
  },
  async remove(id) {
    const { error } = await supabase.from('threads').delete().eq('id', id);
    if (error) throw error;
  },
};

// Manage participants of an existing thread (starter or admin only — RLS enforces).
export const threadParticipants = {
  async listForThread(threadId) {
    const { data, error } = await supabase
      .from('thread_participants')
      .select('user_id, added_at')
      .eq('thread_id', threadId);
    if (error) throw error;
    return data || [];
  },
  async add(threadId, userId) {
    const { error } = await supabase
      .from('thread_participants')
      .insert({ thread_id: threadId, user_id: userId });
    if (error && error.code !== '23505') throw error; // ignore duplicate
  },
  async remove(threadId, userId) {
    const { error } = await supabase
      .from('thread_participants')
      .delete()
      .eq('thread_id', threadId)
      .eq('user_id', userId);
    if (error) throw error;
  },
};

export const threadMessages = {
  async listForThread(threadId) {
    const { data, error } = await supabase
      .from('thread_messages')
      .select('*')
      .eq('thread_id', threadId)
      .order('created_at');
    if (error) throw error;
    return data || [];
  },
  async create({ threadId, body, attachmentUrl, attachmentKind, attachmentLabel }) {
    const userId = (await supabase.auth.getUser()).data.user?.id;
    const { data, error } = await supabase
      .from('thread_messages')
      .insert({
        thread_id: threadId,
        author_id: userId,
        body,
        attachment_url: attachmentUrl || null,
        attachment_kind: attachmentKind || null,
        attachment_label: attachmentLabel || null,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  },
  async markRead(threadId) {
    const userId = (await supabase.auth.getUser()).data.user?.id;
    const { error } = await supabase
      .from('thread_messages')
      .update({ read_by_recipient_at: new Date().toISOString() })
      .eq('thread_id', threadId)
      .neq('author_id', userId)
      .is('read_by_recipient_at', null);
    if (error) console.warn('markRead failed', error);
  },
};

// ----- Incoming emails (inbox for triage) -----

export const emails = {
  async list() {
    const { data, error } = await supabase
      .from('emails')
      .select('*')
      .order('received_at', { ascending: false });
    if (error) throw error;
    return data || [];
  },
  async create(row) {
    // row: { from_email, from_name?, to_emails?, subject?, snippet?, body_text?, received_at, message_id?, source? }
    const { data, error } = await supabase.from('emails').insert(row).select().single();
    if (error) throw error;
    return data;
  },
  // Bulk insert with dedup by message_id. Returns rows actually inserted (skipping duplicates).
  async upsertMany(rows) {
    if (!rows || rows.length === 0) return [];
    const ids = rows.map(r => r.message_id).filter(Boolean);
    let existingIds = new Set();
    if (ids.length) {
      const { data, error } = await supabase
        .from('emails')
        .select('message_id')
        .in('message_id', ids);
      if (error) throw error;
      existingIds = new Set((data || []).map(d => d.message_id));
    }
    const fresh = rows.filter(r => !r.message_id || !existingIds.has(r.message_id));
    if (fresh.length === 0) return [];
    const { data, error } = await supabase.from('emails').insert(fresh).select();
    if (error) throw error;
    return data || [];
  },
  async update(id, patch) {
    const { error } = await supabase.from('emails').update(patch).eq('id', id);
    if (error) throw error;
  },
  async archive(id) {
    return this.update(id, { status: 'archived', triaged_at: new Date().toISOString() });
  },
  async markConverted(id, kind, { taskId, projectId, customerId }) {
    const status = kind === 'task' ? 'converted_task' : kind === 'lead' ? 'converted_lead' : 'converted_both';
    const patch = { status, triaged_at: new Date().toISOString() };
    if (taskId)     patch.converted_to_task_id = taskId;
    if (projectId)  patch.converted_to_project_id = projectId;
    if (customerId) patch.converted_to_customer_id = customerId;
    return this.update(id, patch);
  },
  async remove(id) {
    const { error } = await supabase.from('emails').delete().eq('id', id);
    if (error) throw error;
  },
};

// ----- Realtime -----

export function subscribeAll(onChange) {
  const ch = supabase
    .channel('crm-all')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'customers' }, p => onChange('customers', p))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, p => onChange('projects', p))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, p => onChange('tasks', p))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'files' }, p => onChange('files', p))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'activity' }, p => onChange('activity', p))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'task_notes' }, p => onChange('task_notes', p))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'threads' }, p => onChange('threads', p))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'thread_messages' }, p => onChange('thread_messages', p))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'thread_participants' }, p => onChange('thread_participants', p))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'emails' }, p => onChange('emails', p))
    .subscribe();
  return () => supabase.removeChannel(ch);
}
