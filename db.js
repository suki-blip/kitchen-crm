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

// ----- Realtime -----

export function subscribeAll(onChange) {
  const ch = supabase
    .channel('crm-all')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'customers' }, p => onChange('customers', p))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, p => onChange('projects', p))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, p => onChange('tasks', p))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'files' }, p => onChange('files', p))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'activity' }, p => onChange('activity', p))
    .subscribe();
  return () => supabase.removeChannel(ch);
}
