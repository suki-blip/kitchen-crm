// Supabase Edge Function: send-task-emails
// ---------------------------------------------------------------------------
// Called by:
//   - Postgres trigger `trg_task_assigned` with {kind:'created', task_id, recipient_id}
//   - pg_cron job `kcrm-daily-task-emails` (via notify_daily_scan SQL fn) with {kind:'daily-scan'}
//
// Auth: callers prove they are internal by sending X-Internal-Secret matching
//       Deno.env.get('INTERNAL_NOTIFY_SECRET'). The shared value is stored
//       once in Supabase Vault (so the trigger can read it) and once as an
//       Edge Function secret (so this function can verify it).
//
// Dedup: each (task, recipient, kind, UTC-date) is logged in task_notifications
//        with a unique index. We INSERT first; ON CONFLICT DO NOTHING means a
//        repeat fires the function but never sends a duplicate email.
//
// Opt-out: profiles.notify_email = false short-circuits before sending.
// ---------------------------------------------------------------------------

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE           = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY         = Deno.env.get("RESEND_API_KEY")!;
const INTERNAL_NOTIFY_SECRET = Deno.env.get("INTERNAL_NOTIFY_SECRET") ?? "";

const FROM_ADDR   = "MAKO Cabinets CRM <crm@notifications.makocabinets.com>";
const APP_URL     = "https://suki-blip.github.io/kitchen-crm";
const TIMEZONE    = "Asia/Jerusalem";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function escapeHtml(s: string) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// YYYY-MM-DD in the configured timezone
function todayLocal(): string {
  // en-CA gives ISO format directly
  return new Date().toLocaleDateString("en-CA", { timeZone: TIMEZONE });
}

function formatDate(d: string | null) {
  if (!d) return "—";
  try {
    return new Date(d + "T00:00:00").toLocaleDateString("en-US", {
      timeZone: TIMEZONE,
      day: "2-digit", month: "2-digit", year: "numeric",
    });
  } catch {
    return d;
  }
}

const PRIORITY_LABEL: Record<string, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

// ---------------------------------------------------------------------------
// Data fetch
// ---------------------------------------------------------------------------
interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  due_date: string | null;
  priority: string;
  completed: boolean;
  assigned_to: string | null;
  project_id: string | null;
  // Note: projects has no `name` column — the app composes a label from
  // address + linked customer name.
  projects: { address: string | null; customers: { name: string } | null } | null;
}

interface RecipientInfo {
  id: string;
  name: string;
  email: string;
  notify_email: boolean;
}

async function loadTask(taskId: string): Promise<TaskRow | null> {
  const { data, error } = await supabase
    .from("tasks")
    .select("id, title, description, due_date, priority, completed, assigned_to, project_id, projects(address, customers(name))")
    .eq("id", taskId)
    .maybeSingle();
  if (error) {
    console.error("loadTask error", error);
    return null;
  }
  return data as TaskRow | null;
}

async function loadRecipient(userId: string): Promise<RecipientInfo | null> {
  // profile (name + notify flag)
  const { data: profile, error: pErr } = await supabase
    .from("profiles")
    .select("id, name, notify_email, active")
    .eq("id", userId)
    .maybeSingle();
  if (pErr || !profile) {
    console.error("loadRecipient profile error", pErr);
    return null;
  }

  // auth.users for email (service role has access)
  const { data: userData, error: uErr } = await supabase.auth.admin.getUserById(userId);
  if (uErr || !userData?.user?.email) {
    console.error("loadRecipient auth.users error", uErr);
    return null;
  }

  return {
    id: profile.id,
    name: profile.name,
    email: userData.user.email,
    notify_email: !!profile.notify_email,
  };
}

// ---------------------------------------------------------------------------
// Email composition
// ---------------------------------------------------------------------------
type Kind = "created" | "due_today" | "overdue";

function composeEmail(kind: Kind, task: TaskRow, recipient: RecipientInfo) {
  // Compose project label from address + customer name (no name column on projects).
  const addr = task.projects?.address?.trim();
  const cust = task.projects?.customers?.name?.trim();
  const projectName = [addr, cust].filter(Boolean).join(" — ") || "No project";
  const due = formatDate(task.due_date);
  const priority = PRIORITY_LABEL[task.priority] ?? task.priority;

  let subjectPrefix = "";
  let bannerLabel = "";
  let bannerColor = "#0ea5e9";
  if (kind === "created") {
    subjectPrefix = "New task";
    bannerLabel = "You've been assigned a new task";
  } else if (kind === "due_today") {
    subjectPrefix = "Due today";
    bannerLabel = "Task due today";
    bannerColor = "#f59e0b";
  } else if (kind === "overdue") {
    subjectPrefix = "Overdue";
    bannerLabel = "Overdue task";
    bannerColor = "#ef4444";
  }

  const subject = `[${subjectPrefix}] ${task.title}`;

  const desc = task.description ? escapeHtml(task.description).replace(/\n/g, "<br>") : null;
  const link = `${APP_URL}/#/tasks`;

  const html = `<!doctype html>
<html lang="en" dir="ltr">
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06);">
        <tr><td style="background:${bannerColor};color:#fff;padding:14px 20px;font-weight:600;font-size:14px;letter-spacing:.02em;">
          ${escapeHtml(bannerLabel)}
        </td></tr>
        <tr><td style="padding:24px 28px;">
          <h1 style="margin:0 0 6px;font-size:20px;line-height:1.3;">${escapeHtml(task.title)}</h1>
          <div style="color:#6b7280;font-size:14px;margin-bottom:18px;">${escapeHtml(projectName)}</div>

          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:14px;color:#374151;border-collapse:collapse;">
            <tr><td style="padding:6px 0;color:#6b7280;width:120px;">Due date</td><td style="padding:6px 0;">${escapeHtml(due)}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280;">Priority</td><td style="padding:6px 0;">${escapeHtml(priority)}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280;">Assigned to</td><td style="padding:6px 0;">${escapeHtml(recipient.name)}</td></tr>
          </table>

          ${desc ? `<div style="margin-top:18px;padding:14px 16px;background:#f9fafb;border-left:3px solid ${bannerColor};border-radius:6px;font-size:14px;line-height:1.5;color:#1f2937;">${desc}</div>` : ""}

          <div style="margin-top:24px;">
            <a href="${link}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:500;">Open CRM</a>
          </div>
        </td></tr>
        <tr><td style="padding:14px 28px 22px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px;">
          Automated notification from MAKO Cabinets CRM. To stop receiving alerts: open the CRM → Users → uncheck "Email alerts".
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text =
`${bannerLabel}

${task.title}
Project: ${projectName}
Due: ${due}
Priority: ${priority}
${task.description ? "\n" + task.description + "\n" : ""}
Open CRM: ${link}
`;

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Resend send
// ---------------------------------------------------------------------------
async function sendViaResend(to: string, subject: string, html: string, text: string) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_ADDR,
      to: [to],
      subject,
      html,
      text,
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    return { ok: false as const, error: body?.message || `HTTP ${r.status}`, raw: body };
  }
  return { ok: true as const, id: body?.id as string | undefined };
}

// ---------------------------------------------------------------------------
// Core: emit one email for (task, recipient, kind), with dedup + logging
// ---------------------------------------------------------------------------
async function emit(kind: Kind, task: TaskRow, recipient: RecipientInfo) {
  // Opt-out
  if (!recipient.notify_email) {
    return { sent: false, reason: "opted_out" };
  }
  if (!recipient.email) {
    return { sent: false, reason: "no_email" };
  }
  if (task.completed) {
    return { sent: false, reason: "task_completed" };
  }

  // Dedup: try to insert a row first. Unique index on
  // (task_id, recipient_id, kind, sent_date) blocks repeats.
  // We use status='sent' optimistically; if Resend fails we update to 'failed'.
  const { data: inserted, error: insErr } = await supabase
    .from("task_notifications")
    .insert({
      task_id: task.id,
      recipient_id: recipient.id,
      kind,
      status: "sent",
    })
    .select("id")
    .maybeSingle();

  if (insErr) {
    // Conflict (unique violation) means we already logged this today — skip.
    if (insErr.code === "23505") {
      return { sent: false, reason: "already_sent_today" };
    }
    console.error("task_notifications insert error", insErr);
    return { sent: false, reason: "log_failed", error: insErr.message };
  }
  if (!inserted) {
    return { sent: false, reason: "already_sent_today" };
  }

  // Compose + send
  const { subject, html, text } = composeEmail(kind, task, recipient);
  const result = await sendViaResend(recipient.email, subject, html, text);

  if (result.ok) {
    if (result.id) {
      await supabase
        .from("task_notifications")
        .update({ resend_id: result.id })
        .eq("id", inserted.id);
    }
    return { sent: true, kind, to: recipient.email, resend_id: result.id };
  } else {
    await supabase
      .from("task_notifications")
      .update({ status: "failed", error_message: String(result.error).slice(0, 500) })
      .eq("id", inserted.id);
    return { sent: false, reason: "send_failed", error: result.error };
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
async function handleCreated(taskId: string, recipientId: string) {
  const [task, recipient] = await Promise.all([loadTask(taskId), loadRecipient(recipientId)]);
  if (!task)      return { ok: false, error: "task_not_found" };
  if (!recipient) return { ok: false, error: "recipient_not_found" };
  if (task.assigned_to !== recipient.id) {
    // Defensive: assigned_to changed mid-call.
    return { ok: false, error: "assignment_mismatch" };
  }
  const r = await emit("created", task, recipient);
  return { ok: true, ...r };
}

async function handleDailyScan() {
  const today = todayLocal();
  // Pull all uncompleted tasks with a due_date <= today AND an assignee.
  const { data: tasks, error } = await supabase
    .from("tasks")
    .select("id, title, description, due_date, priority, completed, assigned_to, project_id, projects(address, customers(name))")
    .eq("completed", false)
    .not("assigned_to", "is", null)
    .not("due_date", "is", null)
    .lte("due_date", today);
  if (error) {
    console.error("daily scan query failed", error);
    return { ok: false, error: error.message };
  }

  const results: any[] = [];
  // Cache recipients to avoid N x auth.admin.getUserById round-trips for
  // common assignees.
  const recipientCache = new Map<string, RecipientInfo | null>();

  for (const t of (tasks ?? []) as TaskRow[]) {
    const kind: Kind = (t.due_date === today) ? "due_today" : "overdue";
    if (!t.assigned_to) continue;

    let recipient = recipientCache.get(t.assigned_to);
    if (recipient === undefined) {
      recipient = await loadRecipient(t.assigned_to);
      recipientCache.set(t.assigned_to, recipient);
    }
    if (!recipient) {
      results.push({ task_id: t.id, kind, sent: false, reason: "recipient_not_found" });
      continue;
    }

    const r = await emit(kind, t, recipient);
    results.push({ task_id: t.id, kind, ...r });
  }

  return { ok: true, today, scanned: tasks?.length ?? 0, results };
}

// ---------------------------------------------------------------------------
// HTTP entry
// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResp({ ok: false, error: "method_not_allowed" }, 405);
  }

  // Auth via shared secret (constant-time-ish comparison is fine here since the
  // value is generated random — but use === for simplicity).
  const got = req.headers.get("X-Internal-Secret") ?? "";
  if (!INTERNAL_NOTIFY_SECRET || got !== INTERNAL_NOTIFY_SECRET) {
    return jsonResp({ ok: false, error: "unauthorized" }, 401);
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return jsonResp({ ok: false, error: "invalid_json" }, 400);
  }

  const kind = payload?.kind;
  try {
    if (kind === "created") {
      if (!payload.task_id || !payload.recipient_id) {
        return jsonResp({ ok: false, error: "task_id and recipient_id required" }, 400);
      }
      const r = await handleCreated(payload.task_id, payload.recipient_id);
      return jsonResp(r, r.ok ? 200 : 400);
    } else if (kind === "daily-scan") {
      const r = await handleDailyScan();
      return jsonResp(r, r.ok ? 200 : 500);
    } else {
      return jsonResp({ ok: false, error: "unknown kind" }, 400);
    }
  } catch (err) {
    console.error("handler error", err);
    return jsonResp({ ok: false, error: String(err?.message ?? err) }, 500);
  }
});
