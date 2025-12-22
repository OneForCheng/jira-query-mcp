import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fetch from 'node-fetch';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';

const server = new Server(
  {
    name: 'jira-query-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 配置代理
function createProxyAgent(proxyUrl) {
  if (!proxyUrl) return null;
  
  const url = new URL(proxyUrl);
  const protocol = url.protocol.toLowerCase();
  
  if (protocol.startsWith('socks')) {
    return new SocksProxyAgent(proxyUrl);
  } else if (protocol.startsWith('http')) {
    return new HttpsProxyAgent(proxyUrl);
  } else {
    throw new Error(`Unsupported proxy protocol: ${protocol}`);
  }
}

const proxyAgent = createProxyAgent(process.env.PROXY_AGENT);

// Jira 配置
const JIRA_CONFIG = {
  host: process.env.JIRA_HOST,
  token: process.env.JIRA_API_TOKEN,
  apiVersion: process.env.JIRA_API_VERSION || '2'
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_jira_issue',
        description: 'Get a specific Jira issue by key',
        inputSchema: {
          type: 'object',
          properties: {
            issueKey: {
              type: 'string',
              description: 'The Jira issue key (e.g., PROJ-123)',
            },
          },
          required: ['issueKey'],
        },
      },
      {
        name: 'get_jira_issues',
        description: 'Get all issues and subtasks for a Jira project',
        inputSchema: {
          type: 'object',
          properties: {
            projectKey: {
              type: 'string',
              description: 'Project key (e.g., "PP")',
            },
            jql: {
              type: 'string',
              description: 'Optional JQL to filter issues',
            },
          },
          required: ['projectKey'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'get_jira_issue') {
      const { issueKey } = args;
      const url = `${JIRA_CONFIG.host}/rest/api/${JIRA_CONFIG.apiVersion}/issue/${issueKey}`;

      const fetchOptions = {
        headers: {
          'Authorization': `Bearer ${JIRA_CONFIG.token}`,
          'Content-Type': 'application/json',
        },
      };

      if (proxyAgent) {
        fetchOptions.agent = proxyAgent;
      }

      const response = await fetch(url, fetchOptions);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const issue = await response.json();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              key: issue.key,
              summary: issue.fields.summary,
              description: issue.fields.description,
              status: issue.fields.status.name,
              assignee: issue.fields.assignee?.displayName || 'Unassigned',
              priority: issue.fields.priority.name,
              issueType: issue.fields.issuetype.name,
              created: issue.fields.created,
              updated: issue.fields.updated,
              labels: issue.fields.labels,
              attachments: issue.fields.attachment?.map(a => ({
                filename: a.filename,
                author: a.author.displayName,
                created: a.created,
                size: a.size,
                mimeType: a.mimeType,
                content: a.content
              })) || [],
              comments: issue.fields.comment?.comments?.map(c => ({
                author: c.author.displayName,
                body: c.body,
                created: c.created
              })) || []
            }, null, 2),
          },
        ],
      };
    }

    if (name === 'get_jira_issues') {
      const { projectKey, jql: customJql } = args;
      const jql = customJql 
        ? `project = ${projectKey} AND ${customJql}` 
        : `project = ${projectKey}`;
      
      const url = `${JIRA_CONFIG.host}/rest/api/${JIRA_CONFIG.apiVersion}/search?jql=${encodeURIComponent(jql)}`;

      const fetchOptions = {
        headers: {
          'Authorization': `Bearer ${JIRA_CONFIG.token}`,
          'Content-Type': 'application/json',
        },
      };

      if (proxyAgent) {
        fetchOptions.agent = proxyAgent;
      }

      const response = await fetch(url, fetchOptions);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              total: data.total,
              startAt: data.startAt,
              maxResults: data.maxResults,
              issues: data.issues.map(issue => ({
                key: issue.key,
                id: issue.id,
                summary: issue.fields.summary,
                description: issue.fields.description,
                status: issue.fields.status.name,
                assignee: issue.fields.assignee?.displayName || 'Unassigned',
                reporter: issue.fields.reporter?.displayName || 'Unknown',
                priority: issue.fields.priority?.name || 'None',
                issueType: issue.fields.issuetype.name,
                created: issue.fields.created,
                updated: issue.fields.updated,
                duedate: issue.fields.duedate,
                labels: issue.fields.labels,
                subtasks: issue.fields.subtasks?.map(st => ({
                  key: st.key,
                  summary: st.fields.summary,
                  status: st.fields.status.name
                })) || []
              }))
            }, null, 2),
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
