// Plain-English names for the steps Hermes reports, for the Activity log.
//
// This table decides nothing. Safety is enforced where the action happens: mcp/gate.js for
// mail, calendar and PC tools, and the jarvis-trust plugin for Hermes's own tools.
// `outward` only tells the log to wait for your answer before recording the step.
export const TOOLS = {
  Read: { label: 'Read files' },
  Grep: { label: 'Search inside files' },
  Write: { label: 'Create or overwrite files' },
  Edit: { label: 'Edit files' },
  WebSearch: { label: 'Search the web' },
  WebFetch: { label: 'Read web pages' },
  PowerShell: { label: 'Run PowerShell commands' },
  TodoWrite: { label: 'Keep a task checklist' },

  'mcp__jarvis__open_app': { label: 'Open apps' },
  'mcp__jarvis__open_url': { label: 'Open websites in your browser' },
  'mcp__jarvis__open_path': { label: 'Open files and folders' },
  'mcp__jarvis__screenshot': { label: 'Look at your screen' },
  'mcp__jarvis__clipboard_read': { label: 'Read the clipboard' },
  'mcp__jarvis__clipboard_write': { label: 'Copy to the clipboard' },
  'mcp__jarvis__notify': { label: 'Show notifications' },

  'mcp__google__gmail_search': { label: 'Search your email' },
  'mcp__google__gmail_read': { label: 'Read your email' },
  'mcp__google__gmail_draft': { label: 'Write email drafts' },
  'mcp__google__gmail_send': { label: 'Send email', outward: true },
  'mcp__google__calendar_events': { label: 'Read your calendar' },
  'mcp__google__calendar_free_time': { label: 'Find free time' },
  'mcp__google__calendar_create_event': { label: 'Add events to your calendar' },
  'mcp__google__calendar_invite': { label: 'Invite people to events', outward: true },
  'mcp__google__calendar_update_event': { label: 'Change or move your own events' },
  'mcp__google__calendar_update_shared_event': { label: 'Change events other people are invited to', outward: true },
  'mcp__google__calendar_cancel_event': { label: 'Cancel events', outward: true },
};

export function entryFor(toolName) {
  return TOOLS[toolName] ?? null;
}
