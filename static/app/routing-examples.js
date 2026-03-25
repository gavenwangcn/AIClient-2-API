// 路径路由示例功能模块

import { showToast } from './utils.js';
import { t } from './i18n.js';

/**
 * 初始化路径路由示例功能
 */
function initRoutingExamples() {
    // 延迟初始化，确保所有DOM都加载完成
    setTimeout(() => {
        initProtocolTabs();
        initCopyButtons();
        initCardInteractions();
    }, 100);
}

/**
 * 初始化协议标签切换功能
 */
function initProtocolTabs() {
    // 使用事件委托方式绑定点击事件
    document.addEventListener('click', function(e) {
        // 检查点击的是不是协议标签或者其子元素
        const tab = e.target.classList.contains('protocol-tab') ? e.target : e.target.closest('.protocol-tab');
        
        if (tab) {
            e.preventDefault();
            e.stopPropagation();
            
            const targetProtocol = tab.dataset.protocol;
            const card = tab.closest('.routing-example-card');
            
            if (!card) {
                return;
            }
            
            // 移除当前卡片中所有标签和内容的活动状态
            const cardTabs = card.querySelectorAll('.protocol-tab');
            const cardContents = card.querySelectorAll('.protocol-content');
            
            cardTabs.forEach(t => t.classList.remove('active'));
            cardContents.forEach(c => c.classList.remove('active'));
            
            // 为当前标签和对应内容添加活动状态
            tab.classList.add('active');
            
            // 使用更精确的选择器来查找对应的内容
            const targetContent = card.querySelector(`.protocol-content[data-protocol="${targetProtocol}"]`);
            if (targetContent) {
                targetContent.classList.add('active');
            }
        }
    });
}

/**
 * 初始化复制按钮功能
 */
function initCopyButtons() {
    document.addEventListener('click', async function(e) {
        if (e.target.closest('.copy-btn')) {
            e.stopPropagation();
            
            const button = e.target.closest('.copy-btn');
            const path = button.dataset.path;
            if (!path) return;
            
            try {
                await navigator.clipboard.writeText(path);
                showToast(t('common.success'), `${t('common.success')}: ${path}`, 'success');
                
                // 临时更改按钮图标
                const icon = button.querySelector('i');
                if (icon) {
                    const originalClass = icon.className;
                    icon.className = 'fas fa-check';
                    button.style.color = 'var(--success-color)';
                    
                    setTimeout(() => {
                        icon.className = originalClass;
                        button.style.color = '';
                    }, 2000);
                }
                
            } catch (error) {
                console.error('Failed to copy to clipboard:', error);
                showToast(t('common.error'), t('common.error'), 'error');
            }
        }
    });
}

/**
 * 初始化卡片交互功能
 */
function initCardInteractions() {
    const routingCards = document.querySelectorAll('.routing-example-card');
    
    routingCards.forEach(card => {
        // 添加悬停效果
        card.addEventListener('mouseenter', () => {
            card.style.transform = 'translateY(-4px)';
            card.style.boxShadow = 'var(--shadow-lg)';
        });
        
        card.addEventListener('mouseleave', () => {
            card.style.transform = '';
            card.style.boxShadow = '';
        });
        
    });
}

/**
 * 获取所有可用的路由端点
 * @returns {Array} 路由端点数组
 */
function getAvailableRoutes() {
    return [
        {
            provider: 'forward-api',
            name: 'NewAPI',
            paths: {
                openai: '/forward-api/v1/chat/completions',
                claude: '/forward-api/v1/messages'
            },
            description: t('dashboard.routing.official'),
            badge: t('dashboard.routing.official'),
            badgeClass: 'official'
        },
        {
            provider: 'claude-custom',
            name: 'Claude Custom',
            paths: {
                openai: '/claude-custom/v1/chat/completions',
                claude: '/claude-custom/v1/messages'
            },
            description: t('dashboard.routing.official'),
            badge: t('dashboard.routing.official'),
            badgeClass: 'official'
        },
        {
            provider: 'claude-kiro-oauth',
            name: 'Claude Kiro OAuth',
            paths: {
                openai: '/claude-kiro-oauth/v1/chat/completions',
                claude: '/claude-kiro-oauth/v1/messages'
            },
            description: t('dashboard.routing.free'),
            badge: t('dashboard.routing.free'),
            badgeClass: 'oauth'
        },
        {
            provider: 'openai-custom',
            name: 'OpenAI Custom',
            paths: {
                openai: '/openai-custom/v1/chat/completions',
                claude: '/openai-custom/v1/messages'
            },
            description: t('dashboard.routing.official'),
            badge: t('dashboard.routing.official'),
            badgeClass: 'official'
        },
        {
            provider: 'gemini-cli-oauth',
            name: 'Gemini CLI OAuth',
            paths: {
                openai: '/gemini-cli-oauth/v1/chat/completions',
                claude: '/gemini-cli-oauth/v1/messages'
            },
            description: t('dashboard.routing.oauth'),
            badge: t('dashboard.routing.oauth'),
            badgeClass: 'oauth'
        },
        {
            provider: 'gemini-antigravity',
            name: 'Gemini Antigravity',
            paths: {
                openai: '/gemini-antigravity/v1/chat/completions',
                claude: '/gemini-antigravity/v1/messages'
            },
            description: t('dashboard.routing.experimental') || '实验性',
            badge: t('dashboard.routing.experimental') || '实验性',
            badgeClass: 'oauth'
        },
        {
            provider: 'openai-qwen-oauth',
            name: 'Qwen OAuth',
            paths: {
                openai: '/openai-qwen-oauth/v1/chat/completions',
                claude: '/openai-qwen-oauth/v1/messages'
            },
            description: 'Qwen Code Plus',
            badge: t('dashboard.routing.oauth'),
            badgeClass: 'oauth'
        },
        {
            provider: 'openai-iflow',
            name: 'iFlow OAuth',
            paths: {
                openai: '/openai-iflow/v1/chat/completions',
                claude: '/openai-iflow/v1/messages'
            },
            description: t('dashboard.routing.oauth'),
            badge: t('dashboard.routing.oauth'),
            badgeClass: 'oauth'
        },
        {
            provider: 'openai-codex-oauth',
            name: 'OpenAI Codex OAuth',
            paths: {
                openai: '/openai-codex-oauth/v1/chat/completions',
                claude: '/openai-codex-oauth/v1/messages'
            },
            description: t('dashboard.routing.oauth'),
            badge: t('dashboard.routing.oauth'),
            badgeClass: 'oauth'
        },
        {
            provider: 'consensus-mcp-oauth',
            name: 'Consensus MCP',
            paths: {
                openai: '/consensus-mcp-oauth/v1/chat/completions',
                claude: '/consensus-mcp-oauth/v1/messages',
                mcpTools: '/consensus-mcp-oauth/v1/mcp/tools',
                mcp: '/consensus-mcp-oauth/v1/mcp/call',
                mcpJsonRpc: '/consensus-mcp-oauth/v1/mcp'
            },
            description: '论文检索：OpenAI 兼容聊天；MCP 协议为 POST /v1/mcp（JSON-RPC：initialize / tools/list / tools/call）或 POST /v1/mcp/call',
            badge: 'MCP',
            badgeClass: 'oauth'
        },
        {
            provider: 'openaiResponses-custom',
            name: 'OpenAI Responses',
            paths: {
                openai: '/openaiResponses-custom/v1/responses',
                claude: '/openaiResponses-custom/v1/messages'
            },
            description: '结构化对话API',
            badge: 'Responses',
            badgeClass: 'responses'
        },
        {
            provider: 'grok-custom',
            name: 'Grok Reverse',
            paths: {
                openai: '/grok-custom/v1/chat/completions',
                claude: '/grok-custom/v1/messages'
            },
            description: t('dashboard.routing.free'),
            badge: t('dashboard.routing.free'),
            badgeClass: 'oauth'
        }
    ];
}

/**
 * 高亮显示特定提供商路由
 * @param {string} provider - 提供商标识
 */
function highlightProviderRoute(provider) {
    const card = document.querySelector(`[data-provider="${provider}"]`);
    if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.style.borderColor = 'var(--success-color)';
        card.style.boxShadow = '0 0 0 3px rgba(16, 185, 129, 0.1)';
        
        setTimeout(() => {
            card.style.borderColor = '';
            card.style.boxShadow = '';
        }, 3000);
        
        showToast(t('common.success'), t('common.success') + `: ${provider}`, 'success');
    }
}

/**
 * 复制curl命令示例
 * @param {string} provider - 提供商标识
 * @param {Object} options - 选项参数
 */
async function copyCurlExample(provider, options = {}) {
    const routes = getAvailableRoutes();
    const route = routes.find(r => r.provider === provider);
    
    if (!route) {
        showToast(t('common.error'), t('common.error'), 'error');
        return;
    }
    
    const { protocol = 'openai', model = 'default-model', message = 'Hello!' } = options;
    const path = route.paths[protocol];
    
    if (!path) {
        showToast(t('common.error'), t('common.error'), 'error');
        return;
    }
    
    let curlCommand = '';
    
    // 根据不同提供商和协议生成对应的curl命令
    switch (provider) {
        case 'claude-custom':
        case 'claude-kiro-oauth':
            if (protocol === 'openai') {
                curlCommand = `curl http://localhost:3000${path} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "${message}"}],
    "max_tokens": 1000
  }'`;
            } else {
                curlCommand = `curl http://localhost:3000${path} \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "max_tokens": 1000,
    "messages": [{"role": "user", "content": "${message}"}]
  }'`;
            }
            break;
            
        case 'openai-custom':
        case 'openai-qwen-oauth':
            if (protocol === 'openai') {
                curlCommand = `curl http://localhost:3000${path} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "${message}"}],
    "max_tokens": 1000
  }'`;
            } else {
                curlCommand = `curl http://localhost:3000${path} \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "max_tokens": 1000,
    "messages": [{"role": "user", "content": "${message}"}]
  }'`;
            }
            break;
            
        case 'gemini-cli-oauth':
            if (protocol === 'openai') {
                curlCommand = `curl http://localhost:3000${path} \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gemini-3.1-pro-preview",
    "messages": [{"role": "user", "content": "${message}"}],
    "max_tokens": 1000
  }'`;
            } else {
                curlCommand = `curl http://localhost:3000${path} \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gemini-3.1-pro-preview",
    "max_tokens": 1000,
    "messages": [{"role": "user", "content": "${message}"}]
  }'`;
            }
            break;
            
        case 'openaiResponses-custom':
            if (protocol === 'openai') {
                curlCommand = `curl http://localhost:3000${path} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "input": "${message}",
    "max_output_tokens": 1000
  }'`;
            } else {
                curlCommand = `curl http://localhost:3000${path} \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "max_tokens": 1000,
    "messages": [{"role": "user", "content": "${message}"}]
  }'`;
            }
            break;
        case 'grok-custom':
            if (protocol === 'openai') {
                curlCommand = `curl http://localhost:3000${path} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "grok-3",
    "messages": [{"role": "user", "content": "${message}"}],
    "stream": true
  }'`;
            } else {
                curlCommand = `curl http://localhost:3000${path} \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -d '{
    "model": "grok-3",
    "max_tokens": 1000,
    "messages": [{"role": "user", "content": "${message}"}]
  }'`;
            }
            break;
    }
    
    try {
        await navigator.clipboard.writeText(curlCommand);
        showToast(t('common.success'), t('oauth.success.msg'), 'success');
    } catch (error) {
        console.error('Failed to copy curl command:', error);
        showToast(t('common.error'), t('common.error'), 'error');
    }
}

/**
 * 动态渲染路径路由示例
 * @param {Array} providerConfigs - 提供商配置列表
 */
function renderRoutingExamples(providerConfigs) {
    const container = document.querySelector('.routing-examples-grid');
    if (!container) return;

    container.innerHTML = '';
    
    // 获取路由端点基础信息
    const routes = getAvailableRoutes();
    
    // 图标映射
    const iconMap = {
        'forward-api': 'fa-share-square',
        'gemini-cli-oauth': 'fa-gem',
        'gemini-antigravity': 'fa-rocket',
        'openai-custom': 'fa-comments',
        'claude-custom': 'fa-brain',
        'claude-kiro-oauth': 'fa-robot',
        'openai-qwen-oauth': 'fa-code',
        'openaiResponses-custom': 'fa-comment-alt',
        'openai-iflow': 'fa-wind',
        'openai-codex-oauth': 'fa-keyboard',
        'consensus-mcp-oauth': 'fa-book',
        'grok-custom': 'fa-search'
    };

    // 默认模型映射 (用于 curl 示例)
    const modelMap = {
        'gemini-cli-oauth': 'gemini-3-flash-preview',
        'gemini-antigravity': 'gemini-3-flash-preview',
        'claude-custom': 'claude-sonnet-4-6',
        'claude-kiro-oauth': 'claude-sonnet-4-6',
        'openai-custom': 'gpt-4o',
        'openai-qwen-oauth': 'qwen3-coder-plus',
        'openai-iflow': 'qwen3-max',
        'openai-codex-oauth': 'gpt-5',
        'consensus-mcp-oauth': 'consensus-paper-search',
        'grok-custom': 'grok-3',
        'openaiResponses-custom': 'gpt-4o'
    };

    providerConfigs.forEach(config => {
        if (config.visible === false) return;
        
        let routeInfo = routes.find(r => r.provider === config.id);
        
        // 如果没找到，则创建一个默认的
        if (!routeInfo) {
            routeInfo = {
                provider: config.id,
                name: config.name,
                paths: {
                    openai: `/${config.id}/v1/chat/completions`,
                    claude: `/${config.id}/v1/messages`
                },
                description: t('dashboard.routing.oauth'),
                badge: t('dashboard.routing.oauth'),
                badgeClass: 'oauth'
            };
        }

        const icon = iconMap[config.id] || 'fa-route';
        const defaultModel = modelMap[config.id] || 'default-model';
        const hostname = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 
                         `http://${window.location.host}` : 
                         `${window.location.protocol}//${window.location.host}`;

        const card = document.createElement('div');
        card.className = 'routing-example-card';
        card.dataset.provider = `${config.id}-card`;

        const openaiTabActive = config.id === 'openai-codex-oauth' ? '' : 'active';
        const claudeTabActive = config.id === 'openai-codex-oauth' ? 'active' : '';
        const openaiContentActive = config.id === 'openai-codex-oauth' ? '' : 'active';
        const claudeContentActive = config.id === 'openai-codex-oauth' ? 'active' : '';

        const standardTabs = `
                <div class="protocol-tabs">
                    <button class="protocol-tab ${openaiTabActive}" data-protocol="openai" data-i18n="dashboard.routing.openai">${t('dashboard.routing.openai')}</button>
                    <button class="protocol-tab ${claudeTabActive}" data-protocol="claude" data-i18n="dashboard.routing.claude">${t('dashboard.routing.claude')}</button>
                </div>`;

        const standardOpenaiBlock = `
                <div class="protocol-content ${openaiContentActive}" data-protocol="openai">
                    <div class="endpoint-info">
                        <label data-i18n="dashboard.routing.endpoint">${t('dashboard.routing.endpoint')}</label>
                        <code class="endpoint-path">${routeInfo.paths.openai}</code>
                    </div>
                    <div class="usage-example">
                        <label data-i18n="dashboard.routing.exampleOpenAI">${t('dashboard.routing.exampleOpenAI')}</label>
                        <pre><code>curl ${hostname}${routeInfo.paths.openai} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "${defaultModel}",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 1000
  }'</code></pre>
                    </div>
                </div>`;

        const standardClaudeBlock = `
                <div class="protocol-content ${claudeContentActive}" data-protocol="claude">
                    <div class="endpoint-info">
                        <label data-i18n="dashboard.routing.endpoint">${t('dashboard.routing.endpoint')}</label>
                        <code class="endpoint-path">${routeInfo.paths.claude}</code>
                    </div>
                    <div class="usage-example">
                        <label data-i18n="dashboard.routing.exampleClaude">${t('dashboard.routing.exampleClaude')}</label>
                        <pre><code>curl ${hostname}${routeInfo.paths.claude} \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -d '{
    "model": "${defaultModel}",
    "max_tokens": 1000,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'</code></pre>
                    </div>
                </div>`;

        let cardInnerContent;
        if (config.id === 'consensus-mcp-oauth' && routeInfo.paths.mcpTools && routeInfo.paths.mcp && routeInfo.paths.mcpJsonRpc) {
            cardInnerContent = `
                <div class="protocol-tabs">
                    <button class="protocol-tab ${openaiTabActive}" data-protocol="openai" data-i18n="dashboard.routing.openai">${t('dashboard.routing.openai')}</button>
                    <button class="protocol-tab ${claudeTabActive}" data-protocol="claude" data-i18n="dashboard.routing.claude">${t('dashboard.routing.claude')}</button>
                    <button class="protocol-tab" data-protocol="mcp">${t('dashboard.routing.mcp')}</button>
                </div>
                ${standardOpenaiBlock}
                ${standardClaudeBlock}
                <div class="protocol-content" data-protocol="mcp">
                    <p class="routing-mcp-proxy-note" style="font-size:0.875rem;color:var(--text-secondary, #6b7280);margin:0 0 14px;line-height:1.5;">${t('dashboard.routing.mcpProxyNote')}</p>
                    <h5 style="margin:12px 0 8px;font-size:0.95rem;font-weight:600;">${t('dashboard.routing.mcpSectionCurl')}</h5>
                    <p style="font-size:0.8rem;color:var(--text-secondary, #6b7280);margin:0 0 10px;">${t('dashboard.routing.mcpCurlRemoteHint')}</p>
                    <div class="endpoint-info">
                        <label data-i18n="dashboard.routing.endpoint">${t('dashboard.routing.endpoint')}</label>
                        <code class="endpoint-path">${routeInfo.paths.mcpTools}</code>
                    </div>
                    <div class="usage-example">
                        <label>GET — ${t('dashboard.routing.mcpMcporterListLabel')}（服务侧等价 mcporter list）</label>
                        <pre><code>curl ${hostname}${routeInfo.paths.mcpTools} \\
  -H "Authorization: Bearer YOUR_API_KEY"</code></pre>
                    </div>
                    <div class="endpoint-info" style="margin-top:12px;">
                        <label data-i18n="dashboard.routing.endpoint">${t('dashboard.routing.endpoint')}</label>
                        <code class="endpoint-path">${routeInfo.paths.mcp}</code>
                    </div>
                    <div class="usage-example">
                        <label>POST — ${t('dashboard.routing.mcpMcporterCallLabel')}（服务侧等价 mcporter call）</label>
                        <pre><code>curl ${hostname}${routeInfo.paths.mcp} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{"selector":"consensus.search","args":{"query":"machine learning meta-analysis"}}'</code></pre>
                    </div>
                    <div class="endpoint-info" style="margin-top:12px;">
                        <label data-i18n="dashboard.routing.endpoint">${t('dashboard.routing.endpoint')}</label>
                        <code class="endpoint-path">${routeInfo.paths.mcpJsonRpc}</code>
                    </div>
                    <div class="usage-example">
                        <label>POST — JSON-RPC tools/list</label>
                        <pre><code>curl ${hostname}${routeInfo.paths.mcpJsonRpc} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'</code></pre>
                    </div>
                    <h5 style="margin:18px 0 8px;font-size:0.95rem;font-weight:600;">${t('dashboard.routing.mcpSectionRemoteMcporter')}</h5>
                    <p style="font-size:0.875rem;color:var(--text-secondary, #6b7280);margin:0 0 8px;line-height:1.5;">${t('dashboard.routing.mcpRemoteIntro')}</p>
                    <p style="font-size:0.8rem;color:var(--text-secondary, #6b7280);margin:0 0 12px;">${t('dashboard.routing.mcpRemoteUrlHint')}</p>
                    <div class="usage-example">
                        <label>${t('dashboard.routing.mcpJsonExampleLabel')}</label>
                        <pre><code>{
  "mcpServers": {
    "consensusViaProxy": {
      "url": "${hostname}${routeInfo.paths.mcpJsonRpc}",
      "auth": "none",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}</code></pre>
                    </div>
                    <div class="usage-example">
                        <label>${t('dashboard.routing.mcpMcporterListLabel')}</label>
                        <pre><code>mcporter --config ./mcporter-via-aiclient.json --log-level error \\
  list consensusViaProxy --schema --json</code></pre>
                    </div>
                    <div class="usage-example">
                        <label>${t('dashboard.routing.mcpMcporterCallLabel')}</label>
                        <pre><code>mcporter --config ./mcporter-via-aiclient.json --log-level error \\
  call consensusViaProxy.search query="machine learning review" --output json</code></pre>
                    </div>
                </div>`;
        } else {
            cardInnerContent = `${standardTabs}${standardOpenaiBlock}${standardClaudeBlock}`;
        }

        card.innerHTML = `
            <div class="routing-card-header">
                <i class="fas ${icon}"></i>
                <h4>${routeInfo.name}</h4>
                <span class="provider-badge ${routeInfo.badgeClass}">${routeInfo.badge}</span>
            </div>
            <div class="routing-card-content">
                ${cardInnerContent}
            </div>
        `;
        
        container.appendChild(card);
    });

    // 重新初始化卡片交互
    initCardInteractions();
}

export {
    initRoutingExamples,
    getAvailableRoutes,
    highlightProviderRoute,
    copyCurlExample,
    renderRoutingExamples
};
