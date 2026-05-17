// Supabase configuration — kitchen-crm
// Publishable key is safe to commit/expose: RLS policies in the DB enforce access.
export const SUPABASE_URL = 'https://vfitvtbqzeygthrbdabh.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_C-Wk3z1G_J_XBVxqqEGZ8A_vQzNY6-V';

// Google OAuth — public Client ID for Gmail integration.
// Restricted to JavaScript origins: https://suki-blip.github.io, http://localhost:5180.
// Workspace audience: Internal (makocabinets.com only).
export const GOOGLE_CLIENT_ID = '863404146798-3pk6ejundpb981gaecmq036l5nb7gsav.apps.googleusercontent.com';
export const GMAIL_SCOPES = 'https://www.googleapis.com/auth/gmail.readonly';
