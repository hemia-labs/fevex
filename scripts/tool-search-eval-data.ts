import type { ToolSpec } from '../packages/fevex/src/core';
import type {
  ToolSearchEvalCase,
  ToolSearchEvalDataset,
} from './tool-search-eval-lib';

function tool(
  name: string,
  description: string,
  properties?: Record<string, { type: string; description?: string }>,
): ToolSpec {
  return {
    name,
    description,
    ...(properties === undefined
      ? {}
      : {
          inputSchema: {
            type: 'object',
            properties,
            required: Object.keys(properties),
            additionalProperties: false,
          },
        }),
  };
}

const tools: ToolSpec[] = [
  tool('send_email', 'Send an email message to one or more recipients.', {
    to: { type: 'string', description: 'Recipient email address' },
    subject: { type: 'string' },
    body: { type: 'string' },
  }),
  tool('send_slack_message', 'Post a message to a Slack channel or user.', {
    channel: { type: 'string' },
    text: { type: 'string' },
  }),
  tool('create_teams_message', 'Send a Microsoft Teams chat message.', {
    chat: { type: 'string' },
    text: { type: 'string' },
  }),
  tool('send_sms', 'Send an SMS text message to a phone number.', {
    phone: { type: 'string' },
    text: { type: 'string' },
  }),
  tool('create_calendar_event', 'Schedule a calendar event or meeting.', {
    title: { type: 'string' },
    start: { type: 'string' },
    attendees: { type: 'array' },
  }),
  tool('list_calendar_events', 'List upcoming calendar events.', {
    from: { type: 'string' },
    to: { type: 'string' },
  }),
  tool('find_free_slots', 'Find available meeting times on a calendar.', {
    attendees: { type: 'array' },
    durationMinutes: { type: 'number' },
  }),
  tool('search_contacts', 'Search CRM contacts by name or email.', {
    query: { type: 'string' },
    email: { type: 'string' },
  }),
  tool('create_contact', 'Create a CRM contact.', {
    name: { type: 'string' },
    email: { type: 'string' },
  }),
  tool('update_deal_stage', 'Move a sales deal to a pipeline stage.', {
    dealId: { type: 'string' },
    stage: { type: 'string' },
  }),
  tool('list_deals', 'List CRM deals and their stages.', {}),
  tool('create_invoice', 'Create a customer invoice.', {
    customerId: { type: 'string' },
    amount: { type: 'number' },
  }),
  tool('refund_payment', 'Refund a payment or charge.', {
    paymentId: { type: 'string' },
    amount: { type: 'number' },
  }),
  tool('list_charges', 'List recent charges and payments.', {}),
  tool('get_subscription', 'Get subscription status for a customer.', {
    customerId: { type: 'string' },
  }),
  tool('query_database', 'Run a read-only SQL query against a database.', {
    sql: { type: 'string' },
  }),
  tool('list_tables', 'List database tables.', {}),
  tool('describe_table', 'Describe a database table schema.', {
    table: { type: 'string' },
  }),
  tool('read_file', 'Read a file from disk.', { path: { type: 'string' } }),
  tool('write_file', 'Write a text file to disk.', {
    path: { type: 'string' },
    content: { type: 'string' },
  }),
  tool('list_files', 'List files in a directory.', { path: { type: 'string' } }),
  tool('upload_file', 'Upload a document to storage.', {
    path: { type: 'string' },
    bucket: { type: 'string' },
  }),
  tool('delete_file', 'Delete a file from disk or storage.', {
    path: { type: 'string' },
  }),
  tool('create_pull_request', 'Open a GitHub pull request.', {
    repository: { type: 'string' },
    title: { type: 'string' },
    head: { type: 'string' },
  }),
  tool('list_pull_requests', 'List GitHub pull requests.', {
    repository: { type: 'string' },
    state: { type: 'string' },
  }),
  tool('merge_pull_request', 'Merge a GitHub pull request.', {
    repository: { type: 'string' },
    number: { type: 'number' },
  }),
  tool('comment_on_issue', 'Comment on a GitHub issue.', {
    repository: { type: 'string' },
    issue: { type: 'number' },
    body: { type: 'string' },
  }),
  tool('create_branch', 'Create a Git branch.', {
    repository: { type: 'string' },
    name: { type: 'string' },
  }),
  tool('create_issue', 'Create a Jira or Linear issue.', {
    project: { type: 'string' },
    title: { type: 'string' },
  }),
  tool('update_issue', 'Update an issue status or assignee.', {
    issueId: { type: 'string' },
    status: { type: 'string' },
  }),
  tool('list_issues', 'List project issues.', { project: { type: 'string' } }),
  tool('web_search', 'Search the public web.', { query: { type: 'string' } }),
  tool('fetch_url', 'Fetch a URL and return its text.', { url: { type: 'string' } }),
  tool('open_url', 'Open a URL in a browser.', { url: { type: 'string' } }),
  tool('take_screenshot', 'Capture a screenshot of a web page.', {
    url: { type: 'string' },
  }),
  tool('deploy_service', 'Deploy a service to an environment.', {
    service: { type: 'string' },
    environment: { type: 'string' },
  }),
  tool('rollback_deployment', 'Roll back the last deployment.', {
    service: { type: 'string' },
  }),
  tool('get_service_logs', 'Fetch logs for a service.', {
    service: { type: 'string' },
    since: { type: 'string' },
  }),
  tool('create_time_off_request', 'Request vacation or time off.', {
    start: { type: 'string' },
    end: { type: 'string' },
  }),
  tool('list_employees', 'List employees in the organization.', {}),
  tool('run_report', 'Generate a revenue or analytics report.', {
    metric: { type: 'string' },
    period: { type: 'string' },
  }),
  tool('get_metrics', 'Fetch product metrics for a time range.', {
    metric: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
  }),
  tool('schedule_reminder', 'Schedule a reminder for a future time.', {
    message: { type: 'string' },
    at: { type: 'string' },
  }),
  tool('translate_text', 'Translate text between languages.', {
    text: { type: 'string' },
    targetLanguage: { type: 'string' },
  }),
  tool('summarize_document', 'Summarize a document.', {
    documentId: { type: 'string' },
  }),
  tool('search_documents', 'Search internal documents.', {
    query: { type: 'string' },
  }),
  tool('create_support_ticket', 'Open a support ticket.', {
    subject: { type: 'string' },
    customerId: { type: 'string' },
  }),
  tool('escalate_ticket', 'Escalate a support ticket.', {
    ticketId: { type: 'string' },
  }),
  tool('get_customer', 'Get a customer profile.', {
    customerId: { type: 'string' },
  }),
  tool('add_note', 'Add a note to a customer record.', {
    customerId: { type: 'string' },
    note: { type: 'string' },
  }),
];

const cases: ToolSearchEvalCase[] = [
  { query: 'send an email to the customer', expected: ['send_email'], tags: ['exact'] },
  { query: 'notify the customer by email', expected: ['send_email'], tags: ['synonym'] },
  { query: 'post in the team Slack channel', expected: ['send_slack_message'], tags: ['exact'] },
  { query: 'message the team on Teams', expected: ['create_teams_message'], tags: ['synonym'] },
  { query: 'text the customer', expected: ['send_sms'], tags: ['synonym'] },
  { query: 'book a meeting next week', expected: ['create_calendar_event'], tags: ['synonym'] },
  { query: 'what meetings do I have tomorrow', expected: ['list_calendar_events'], tags: ['exact'] },
  { query: 'find a time when everyone is free', expected: ['find_free_slots'], tags: ['synonym'] },
  { query: 'look up a contact by email', expected: ['search_contacts'], tags: ['schema'] },
  { query: 'add a new CRM contact', expected: ['create_contact'], tags: ['exact'] },
  { query: 'move the deal to closed won', expected: ['update_deal_stage'], tags: ['synonym'] },
  { query: 'show all sales deals', expected: ['list_deals'], tags: ['exact'] },
  { query: 'bill the customer', expected: ['create_invoice'], tags: ['synonym'] },
  {
    query: 'give the customer their money back',
    expected: ['refund_payment'],
    tags: ['synonym'],
  },
  { query: 'list recent charges', expected: ['list_charges'], tags: ['exact'] },
  { query: 'is the subscription active', expected: ['get_subscription'] },
  { query: 'run a SQL query', expected: ['query_database'], tags: ['exact'] },
  { query: 'what tables are in the database', expected: ['list_tables'] },
  { query: 'describe the schema of the orders table', expected: ['describe_table'], tags: ['schema'] },
  { query: 'read the README file', expected: ['read_file'] },
  { query: 'save this to a file', expected: ['write_file'], tags: ['synonym'] },
  { query: 'list files in the project', expected: ['list_files'] },
  { query: 'upload the PDF', expected: ['upload_file'] },
  { query: 'remove the old log file', expected: ['delete_file'], tags: ['synonym'] },
  { query: 'raise a PR', expected: ['create_pull_request'], tags: ['acronym'] },
  { query: 'show open pull requests', expected: ['list_pull_requests'] },
  { query: 'merge the pull request', expected: ['merge_pull_request'] },
  { query: 'comment on the GitHub issue', expected: ['comment_on_issue'] },
  { query: 'create a branch for the fix', expected: ['create_branch'] },
  { query: 'file a bug', expected: ['create_issue'], tags: ['synonym'] },
  { query: 'change the issue status to done', expected: ['update_issue'] },
  { query: 'list my issues', expected: ['list_issues'] },
  { query: 'search the web for pricing', expected: ['web_search'] },
  { query: 'fetch the page at this URL', expected: ['fetch_url'] },
  { query: 'open the checkout page in a browser', expected: ['open_url'] },
  { query: 'take a screenshot of the dashboard', expected: ['take_screenshot'] },
  { query: 'deploy the API to production', expected: ['deploy_service'] },
  { query: 'roll back the last deploy', expected: ['rollback_deployment'], tags: ['synonym'] },
  { query: 'show logs for the payments service', expected: ['get_service_logs'] },
  { query: 'request vacation next month', expected: ['create_time_off_request'], tags: ['synonym'] },
  { query: 'list all employees', expected: ['list_employees'] },
  { query: 'generate a revenue report', expected: ['run_report'] },
  { query: 'show weekly active users', expected: ['get_metrics'], tags: ['synonym'] },
  {
    query: 'remind me to call the customer tomorrow',
    expected: ['schedule_reminder'],
    tags: ['synonym'],
  },
  { query: 'translate this message to Spanish', expected: ['translate_text'] },
  { query: 'summarize this document', expected: ['summarize_document'] },
  { query: 'search internal docs for SSO', expected: ['search_documents'], tags: ['synonym'] },
  { query: 'open a support ticket', expected: ['create_support_ticket'] },
  { query: 'escalate the support ticket', expected: ['escalate_ticket'] },
  { query: 'get the customer profile', expected: ['get_customer'] },
  { query: 'add a note to the customer', expected: ['add_note'] },
];

export const toolSearchEvalDataset: ToolSearchEvalDataset = {
  name: 'fevex-tool-search-baseline',
  tools,
  cases,
};
