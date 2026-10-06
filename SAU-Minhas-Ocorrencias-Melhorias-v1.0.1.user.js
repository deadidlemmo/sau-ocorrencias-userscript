// ==UserScript==
// @name         SAU - Minhas Ocorrencias - Melhorias
// @namespace    sau.pg.tampermonkey
// @version      1.0.1
// @description  Melhora a tela Minhas Ocorrencias do SAU com pesquisa, filtros, historico global, paginacao, previa, navegacao, conclusao rapida e recursos de qualidade de vida, preservando o funcionamento do sistema original.
// @match        https://servico.intra.pg/sau/ocorr_minhas.asp*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // Nao executa dentro dos iframes ocultos usados para carregar as paginas do historico.
    try {
        if (window !== window.top && window.frameElement?.dataset?.sauLoader === '1') return;
    } catch (_) {}

    const CFG = {
        concorrencia: 1,
        tamanhoPadrao: 25,
        tamanhosPagina: [25, 50, 100, 200],
        resumoPadrao: 2,
        debounceBusca: 250,
        cacheMinutos: 10,
        storageKey: 'sauMinhasOcorrencias:v510:estado',
        prefsKey: 'sauMinhasOcorrencias:v510:prefs',
        cacheKey: 'sauMinhasOcorrencias:v510:cache',
        viewsKey: 'sauMinhasOcorrencias:v54:views',
        categorias: {
            informatica: [
                'cpu', 'computador', 'notebook', 'monitor', 'teclado', 'mouse', 'impressora',
                'scanner', 'login', 'senha', 'usuario', 'acesso', 'sistema', 'internet', 'rede',
                'wifi', 'wi-fi', 'email', 'e-mail', 'telefone', 'ramal', 'software', 'hardware',
                'windows', 'office', 'compartilhamento', 'pasta', 'servidor'
            ],
            manutencao: [
                'manutencao', 'reparo', 'conserto', 'infiltracao', 'vazamento', 'telhado', 'calha',
                'porta', 'janela', 'pintura', 'eletrica', 'hidraulica', 'torneira', 'vaso', 'banheiro',
                'poda', 'arvore', 'desratizacao', 'dedetizacao', 'obra', 'quadra', 'parede', 'piso',
                'forro', 'goteira', 'fechadura', 'lampada', 'iluminacao'
            ]
        }
    };

    // Definições dos campos de filtro instantâneo precisam existir antes da inicialização.
    // Na versão 0.5.4 esta constante ficava mais abaixo no arquivo; como o bootstrap
    // chamava instalarFiltrosTopoInstantaneos() antes de chegar nela, o navegador lançava
    // ReferenceError (Temporal Dead Zone) e interrompia o script logo após montar o cabeçalho.
    const TOP_LIVE_DEFS = [
        ['txtNr', 'Nº'],
        ['txtEtiqueta', 'Etiqueta'],
        ['txtDtAbertura', 'Abertura'],
        ['txtDtConclusao', 'Conclusão']
    ];

    const form = document.getElementById('frmConsulta');
    const hidCurrentPage = document.getElementById('hidCurrentPage');
    if (!form || !hidCurrentPage) return;
    const painelOriginal = form.querySelector(':scope > div:first-of-type');

    // Guarda os campos exatamente como vieram do servidor. O carregador do histórico
    // usa este snapshot; assim, digitar nos filtros instantâneos não altera as páginas
    // que ainda estão sendo buscadas em segundo plano.
    const camposServidorBase = capturarCamposServidorBase();
    const camposServidorBaseMap = new Map(camposServidorBase);

    const tabelaOriginal = localizarTabelaResultados();
    if (!tabelaOriginal) return;

    // Extrai a primeira página ANTES de qualquer alteração visual. Isso evita que
    // mudanças de CSS/DOM ou novas tabelas criadas pelo script interfiram na leitura
    // da grade legada do SAU.
    const registrosIniciais = extrairRegistrosDaTabela(tabelaOriginal);
    // Fail-safe: se há linhas na grade mas nenhuma pôde ser interpretada, não esconde
    // nem altera a tela original. Assim uma mudança inesperada no HTML do SAU nunca
    // resulta em uma página vazia.
    if (tabelaOriginal.rows.length > 1 && registrosIniciais.length === 0) {
        console.warn('[SAU QOL] A grade foi encontrada, mas nenhuma ocorrência pôde ser lida. Interface original preservada.');
        return;
    }

    const paginacaoOriginal = localizarPaginacaoOriginal();
    const ajudaOriginal = localizarAjudaOriginal();
    const legendaOriginal = localizarLegendaOriginal();

    // Captura ANTES de esconder a interface antiga.
    const paginacaoInicial = extrairPaginacao(document);
    const assinaturaServidor = assinaturaFiltrosServidor();
    const estadoSalvo = carregarJSON(sessionStorage, CFG.storageKey, {});
    const prefs = carregarJSON(localStorage, CFG.prefsKey, {});

    const state = {
        registros: [],
        registrosPorNumero: new Map(),
        detalhesCache: new Map(),
        conclusoesSemConfirmacao: new Set(),
        carregando: false,
        atualizando: false,
        atualizacaoPromise: null,
        progressoAtualizacao: null,
        erroAtualizacao: '',
        historicoInconsistente: false,
        geracaoCarga: 0,
        carregadoCompleto: false,
        paginasCarregadas: 0,
        totalPaginasServidor: paginacaoInicial.total,
        paginasComErro: [],
        paginasConfirmadas: new Set(),
        pesquisa: estadoSalvo.pesquisa || '',
        situacao: estadoSalvo.situacao || 'todas',
        periodo: estadoSalvo.periodo || 'todos',
        visualizacao: '',
        porPagina: Number(estadoSalvo.porPagina ?? prefs.porPagina) || CFG.tamanhoPadrao,
        resumoLinhas: [1, 2].includes(Number(estadoSalvo.resumoLinhas ?? prefs.resumoLinhas))
            ? Number(estadoSalvo.resumoLinhas ?? prefs.resumoLinhas)
            : CFG.resumoPadrao,
        pagina: Math.max(1, Number(estadoSalvo.pagina) || 1),
        sortKey: estadoSalvo.sortKey || 'abertura',
        sortDir: estadoSalvo.sortDir === 'asc' ? 'asc' : 'desc',
        sortManual: !!estadoSalvo.sortManual,
        atualizadoEm: 0,
        cacheRestaurado: false,
        selectedIndex: -1,
        previewNumero: null
    };

    // Sempre inclui a página que veio do servidor antes de montar a interface.
    for (const reg of registrosIniciais) state.registrosPorNumero.set(reg.numero, reg);
    state.registros = [...state.registrosPorNumero.values()];

    prepararPagina();
    const ui = criarInterface();
    instalarFiltrosTopoInstantaneos();
    instalarTooltip();
    instalarAtalhos();
    instalarEventosTabela();
    ativarInterfaceMelhorada();

    window.addEventListener('error', ev => {
        try {
            console.error('[SAU QOL] Erro de execução:', ev.error || ev.message);
            if (ui?.warning && !ui.warning.textContent) {
                ui.warning.innerHTML = '<div class="sau-warn">O complemento encontrou um erro de interface. Os dados do SAU continuam preservados; use Atualizar ou desative o script para voltar à grade original.</div>';
            }
        } catch (_) {}
    });

    state.paginasConfirmadas.add(paginacaoInicial.atual);
    state.paginasCarregadas = state.paginasConfirmadas.size;

    // Se houver cache completo da mesma consulta do servidor, restaura na hora.
    const cacheOk = restaurarCacheSeValido();
    atualizarSituacoes();
    atualizarContadoresRapidos();
    renderizar();

    if (!cacheOk) {
        carregarTodasAsPaginas(paginacaoInicial.atual);
    }

    // -------------------------------------------------------------------------
    // Persistencia
    // -------------------------------------------------------------------------

    function carregarJSON(storage, key, fallback) {
        try {
            return JSON.parse(storage.getItem(key) || '') || fallback;
        } catch (_) {
            return fallback;
        }
    }

    function salvarEstado() {
        try {
            sessionStorage.setItem(CFG.storageKey, JSON.stringify({
                pesquisa: state.pesquisa,
                situacao: state.situacao,
                periodo: state.periodo,
                visualizacao: state.visualizacao,
                porPagina: state.porPagina,
                resumoLinhas: state.resumoLinhas,
                pagina: state.pagina,
                sortKey: state.sortKey,
                sortDir: state.sortDir,
                sortManual: state.sortManual,
                baseAssinatura: assinaturaServidor,
                topLive: lerFiltrosTopoInstantaneos()
            }));
        } catch (_) {}

        try {
            localStorage.setItem(CFG.prefsKey, JSON.stringify({
                porPagina: state.porPagina,
                resumoLinhas: state.resumoLinhas
            }));
        } catch (_) {}
    }

    function capturarCamposServidorBase() {
        const arr = [];
        const fd = new FormData(form);
        for (const [k, v] of fd.entries()) {
            if (k === 'hidCurrentPage') continue;
            if (typeof v === 'string') arr.push([k, v]);
        }
        return arr;
    }

    function assinaturaFiltrosServidor() {
        const arr = camposServidorBase.map(([k, v]) => [k, v]);
        arr.sort((a, b) => a[0].localeCompare(b[0]) || String(a[1]).localeCompare(String(b[1])));
        return JSON.stringify(arr);
    }

    function restaurarCacheSeValido() {
        const cache = carregarJSON(sessionStorage, CFG.cacheKey, null);
        if (!cache || cache.assinatura !== assinaturaServidor || !Array.isArray(cache.registros)) return false;
        const idade = Date.now() - Number(cache.timestamp || 0);
        if (idade < 0 || idade > CFG.cacheMinutos * 60 * 1000) return false;

        state.registrosPorNumero.clear();
        for (const r of cache.registros) {
            reidratarRegistro(r);
            state.registrosPorNumero.set(r.numero, r);
        }
        state.registros = [...state.registrosPorNumero.values()];
        state.totalPaginasServidor = Number(cache.totalPaginas) || paginacaoInicial.total;
        state.paginasConfirmadas = new Set(Array.from({ length: state.totalPaginasServidor }, (_, i) => i + 1));
        state.paginasCarregadas = state.paginasConfirmadas.size;
        state.paginasComErro = [];
        state.carregando = false;
        state.carregadoCompleto = true;
        state.atualizadoEm = Number(cache.timestamp) || Date.now();
        state.cacheRestaurado = true;
        return true;
    }

    function salvarCacheCompleto() {
        if (!state.carregadoCompleto) return;
        try {
            sessionStorage.setItem(CFG.cacheKey, JSON.stringify({
                assinatura: assinaturaServidor,
                timestamp: state.atualizadoEm || Date.now(),
                totalPaginas: state.totalPaginasServidor,
                registros: state.registros
            }));
        } catch (e) {
            console.warn('[SAU QOL] Cache nao pode ser salvo:', e);
        }
    }

    function limparCache() {
        try { sessionStorage.removeItem(CFG.cacheKey); } catch (_) {}
    }

    function assinaturaPagina(doc) {
        return extrairRegistros(doc).map(r => [r.numero, r.situacao, r.dtAbert, r.hrAbert, r.dtConc, r.hrConc].join('|')).join('\n');
    }

    // -------------------------------------------------------------------------
    // Utilidades de texto/data
    // -------------------------------------------------------------------------

    function norm(s) {
        return String(s ?? '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    function texto(el) {
        return (el?.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function parseDataHora(data, hora) {
        const m = String(data || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
        if (!m) return 0;
        const hm = String(hora || '').match(/(\d{1,2}):(\d{2})/);
        const h = hm ? Number(hm[1]) : 0;
        const min = hm ? Number(hm[2]) : 0;
        return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), h, min).getTime();
    }

    function inicioDoDia(ts = Date.now()) {
        const d = new Date(ts);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    }

    function diasEmAberto(r) {
        if (!r.abertura || ehConcluido(r)) return null;
        return Math.max(0, Math.floor((inicioDoDia(Date.now()) - inicioDoDia(r.abertura)) / 86400000));
    }

    function formatarTempoAberto(r) {
        const dias = diasEmAberto(r);
        if (dias === null) return '';
        if (dias === 0) return 'aberto hoje';
        if (dias === 1) return 'aberto há 1 dia';
        return `aberto há ${dias} dias`;
    }

    function formatarHora(ts) {
        if (!ts) return '';
        try {
            return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
        } catch (_) {
            return '';
        }
    }

    function htmlParaTexto(html) {
        const div = document.createElement('div');
        div.innerHTML = String(html || '').replace(/<br\s*\/?>/gi, '\n');
        return (div.textContent || '')
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n\s*\n+/g, '\n')
            .trim();
    }

    function extrairMotivo(link) {
        if (!link) return '';
        const over = link.getAttribute('onmouseover') || link.getAttribute('ONMOUSEOVER') || '';
        let m = over.match(/<strong>\s*Motivo:\s*<\/strong>([\s\S]*?)'\s*,\s*'#[0-9a-f]{3,8}'/i);
        if (!m) m = over.match(/<strong>\s*Motivo:\s*<\/strong>([\s\S]*?)'\s*,/i);
        return m ? htmlParaTexto(m[1]) : '';
    }

    function extrairCodigoDetalhe(link) {
        if (!link) return '';
        const onClick = link.getAttribute('onclick') || '';
        const m = onClick.match(/ocorr_detalhes\.asp\?cd=(\d+)/i);
        return m ? m[1] : texto(link);
    }

    function reidratarRegistro(r) {
        r.abertura = Number(r.abertura) || parseDataHora(r.dtAbert, r.hrAbert);
        r.conclusao = Number(r.conclusao) || parseDataHora(r.dtConc, r.hrConc);
        r.situacaoNorm = norm(r.situacao);
        r.searchText = norm([
            r.numero, r.codigo, r.etiqueta, r.dtAbert, r.hrAbert,
            r.dtConc, r.hrConc, r.situacao, r.motivo
        ].join(' '));
        r.detalheUrl = r.detalheUrl || `ocorr_detalhes.asp?cd=${encodeURIComponent(r.numero)}`;
        return r;
    }

    function ehConcluido(r) {
        return r.situacaoNorm.includes('conclu');
    }

    function ehEmAndamento(r) {
        return r.situacaoNorm.includes('andamento');
    }

    // -------------------------------------------------------------------------
    // Leitura do HTML legado
    // -------------------------------------------------------------------------

    function localizarTabelaResultados(doc = document) {
        // Não depende dos textos dos cabeçalhos (o SAU usa ISO-8859-1 e alguns
        // navegadores podem expor caracteres corrompidos). Identifica a grade pela
        // estrutura real das linhas e pelo link de detalhe da ocorrência.
        const frm = doc.getElementById?.('frmConsulta');
        const tabelas = frm ? [...frm.querySelectorAll('table')] : [...doc.querySelectorAll('table')];

        const estrutural = tabelas.find(t => {
            if (!t.rows || t.rows.length < 2) return false;
            if ((t.rows[0]?.cells?.length || 0) < 8) return false;
            return [...t.rows].slice(1, Math.min(t.rows.length, 8)).some(tr => {
                if ((tr.cells?.length || 0) < 9) return false;
                const a = tr.querySelector('a[onclick*="ocorr_detalhes.asp?cd="]');
                if (!a) return false;
                const n = extrairCodigoDetalhe(a);
                return /^\d+$/.test(n);
            });
        });
        if (estrutural) return estrutural;

        // Fallback por cabeçalhos, aceitando variações de codificação.
        return tabelas.find(t => {
            const head = norm(t.rows?.[0]?.textContent || '');
            return (head.includes('eqpto') || head.includes('equip')) &&
                   head.includes('etiqueta') &&
                   (head.includes('situacao') || head.includes('situa'));
        }) || null;
    }

    function localizarPaginacaoOriginal() {
        return [...document.querySelectorAll('table')].find(t => /pag\.\s*\d+\s*de\s*\d+/i.test(texto(t))) || null;
    }

    function localizarAjudaOriginal() {
        return [...document.querySelectorAll('span')].find(s => /\bajuda\b/i.test(texto(s)) && /abreHelp/i.test(s.getAttribute('onclick') || ''))?.parentElement || null;
    }

    function localizarLegendaOriginal() {
        return [...document.querySelectorAll('table')].find(t => {
            const tx = norm(texto(t));
            return tx.includes('em andamento - pendente') && tx.includes('em andamento - em verificacao');
        }) || null;
    }

    function extrairPaginacao(doc) {
        // textContent continua funcionando mesmo quando a paginação foi ocultada pelo CSS.
        const body = doc.body?.textContent || '';
        const m = body.match(/pag\.\s*(\d+)\s*de\s*(\d+)/i);
        return {
            atual: m ? Number(m[1]) : 1,
            total: m ? Math.max(1, Number(m[2])) : 1,
            encontrada: !!m
        };
    }

    function extrairRegistrosDaTabela(table) {
        if (!table) return [];
        const out = [];

        for (const tr of [...table.rows].slice(1)) {
            const cells = [...tr.cells];
            if (cells.length < 9) continue;

            // A segunda coluna normalmente contém o número, mas procuramos pelo link
            // de detalhe na linha inteira para tolerar pequenas mudanças no HTML legado.
            const link = tr.querySelector('a[onclick*="ocorr_detalhes.asp?cd="]') || cells[1]?.querySelector('a');
            const numero = extrairCodigoDetalhe(link);
            if (!/^\d+$/.test(numero)) continue;

            const r = {
                numero,
                codigo: texto(cells[2]),
                etiqueta: texto(cells[3]),
                dtAbert: texto(cells[4]),
                hrAbert: texto(cells[5]),
                dtConc: texto(cells[6]),
                hrConc: texto(cells[7]),
                situacao: texto(cells[8]),
                motivo: extrairMotivo(link),
                eye: cells[0]?.querySelector('img')?.getAttribute('src') || '',
                detalheUrl: `ocorr_detalhes.asp?cd=${encodeURIComponent(numero)}`
            };
            out.push(reidratarRegistro(r));
        }
        return out;
    }

    function extrairRegistros(doc) {
        return extrairRegistrosDaTabela(localizarTabelaResultados(doc));
    }

    function extrairEAdicionar(doc) {
        for (const reg of extrairRegistros(doc)) {
            const antigo = state.registrosPorNumero.get(reg.numero);
            if (!antigo || (reg.motivo || '').length > (antigo.motivo || '').length) {
                state.registrosPorNumero.set(reg.numero, reg);
            }
        }
        state.registros = [...state.registrosPorNumero.values()];
    }

    // -------------------------------------------------------------------------
    // Aparencia - proxima ao SAU original
    // -------------------------------------------------------------------------

    function prepararPagina() {
        const style = document.createElement('style');
        style.textContent = `
            html.sau-enhanced, body.sau-enhanced-body { background:#fff !important; }
            body.sau-enhanced-body {
                margin:0 !important; padding:7px 8px 58px !important;
                font-family:Verdana,Arial,Helvetica,sans-serif !important;
                font-size:10px !important; color:#000 !important;
            }
            body.sau-enhanced-body > div[align="center"] { width:100% !important; }
            body.sau-enhanced-body > div[align="center"] > p:first-child {
                text-align:left !important; margin:2px 0 7px !important;
            }
            body.sau-enhanced-body > div[align="center"] > p:first-child .texto {
                font-size:12px !important; color:#003300 !important;
            }

            /* O formulário legado continua existindo e enviando os mesmos nomes de campos,
               mas sua apresentação original é escondida; os próprios inputs são movidos
               para o painel unificado abaixo. */
            body.sau-enhanced-body #frmConsulta > .sau-original-panel { display:none !important; }
            body.sau-enhanced-body #frmConsulta > hr { display:none !important; }
            #frmConsulta .sau-live-field-active { background:#fffef2 !important; border-color:#7fa67f !important; }

            #sau-global-ui { width:100%; margin-top:2px; }
            .sau-filter-panel { border:1px solid #b7cec5; background:#f9fbfa; }
            .sau-panel-title {
                padding:5px 7px 2px; color:#003300; font-weight:bold; font-size:10px;
            }
            .sau-toolbar {
                display:grid; grid-template-columns:minmax(260px,1.5fr) 150px 78px 82px auto;
                gap:6px; align-items:end; padding:5px 7px 6px; background:#eaf4f1;
                border-top:1px solid #d6e3de;
            }
            .sau-specific-grid {
                display:grid; grid-template-columns:0.75fr 1.15fr 0.85fr 0.85fr 1fr 1.45fr;
                gap:6px; padding:6px 7px; background:#f9fbfa; border-top:1px solid #d9e5e1;
            }
            .sau-server-field label { display:block; margin-bottom:3px; color:#003300; font-size:9px; }
            .sau-server-field input,.sau-server-field select {
                width:100% !important; box-sizing:border-box !important; height:23px !important; padding:2px 5px !important;
                border:1px solid #9eb9af !important; background:#fff !important; color:#003366 !important;
                font-family:Verdana,Arial,Helvetica,sans-serif !important; font-size:10px !important;
            }
            .sau-field label { display:block; margin-bottom:3px; color:#003300; font-weight:bold; font-size:9px; }
            .sau-field input,.sau-field select {
                width:100%; box-sizing:border-box; height:23px; padding:2px 5px;
                border:1px solid #9eb9af; background:#fff; color:#003366;
                font-family:Verdana,Arial,Helvetica,sans-serif; font-size:10px;
            }
            .sau-actions { display:flex; gap:4px; flex-wrap:wrap; align-items:center; }
            .sau-btn {
                height:23px; padding:0 8px; border:1px solid #7fa67f; background:#f3f3f3; color:#1e5f1e;
                font-family:Verdana,Arial,Helvetica,sans-serif; font-size:9px; font-weight:bold;
                cursor:pointer; white-space:nowrap;
            }
            .sau-btn:hover { background:#e8f5e9; }
            .sau-btn.primary { background:#003300; color:#fff; border-color:#003300; }
            .sau-btn.danger-lite { color:#7a2600; border-color:#bb9a8a; }

            .sau-shortcuts {
                display:flex; align-items:center; gap:4px; flex-wrap:wrap; padding:5px 6px;
                border-top:1px solid #d9e5e1; border-bottom:0;
                background:#f9fbfa;
            }
            .sau-strip-label { color:#486058; font-weight:bold; font-size:9px; margin-right:2px; }
            .sau-chip-btn {
                height:21px; padding:0 7px; border:1px solid #b5c9c1; background:#fff; color:#003300;
                font-family:Verdana,Arial,Helvetica,sans-serif; font-size:9px; cursor:pointer; white-space:nowrap;
            }
            .sau-chip-btn:hover { background:#eef7f3; }
            .sau-chip-btn.active { background:#003300; color:#fff; border-color:#003300; font-weight:bold; }
            .sau-chip-btn.status-open.active { background:#8a6200; border-color:#8a6200; }
            .sau-chip-btn.status-done.active { background:#006600; border-color:#006600; }
            .sau-chip-btn .count { opacity:.75; margin-left:2px; }
            .sau-view-remove { margin-left:4px; font-weight:bold; opacity:.75; }

            .sau-active-filters {
                display:flex; align-items:center; gap:4px; flex-wrap:wrap; min-height:22px; padding:3px 5px;
                border-top:1px solid #d9e5e1;
                color:#486058; font-size:9px; background:#fbfdfc;
            }
            .sau-filter-tag {
                display:inline-flex; align-items:center; gap:4px; padding:2px 5px; border:1px solid #cadbd5;
                background:#fff; color:#003300;
            }
            .sau-filter-tag button { border:0; background:transparent; color:#6b7773; cursor:pointer; padding:0; font:bold 11px Verdana; }
            .sau-filter-tag.server { background:#f7f7f7; color:#333; }
            .sau-muted { color:#71817b; }

            .sau-progress-wrap { display:none; height:3px; background:#dce9e4; overflow:hidden; }
            .sau-progress { width:0%; height:100%; background:#006633; transition:width .15s ease; }
            .sau-statusbar {
                display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;
                padding:5px 1px 4px; color:#486058; font-size:9px;
            }
            .sau-load-incomplete { color:#8a6200 !important; font-weight:bold; }

            .sau-table-wrap {
                position:relative; width:100%; max-height:66vh; overflow-y:auto; overflow-x:hidden;
                border-top:1px solid #ccdcd6; border-left:1px solid #e0e9e6; background:#fff;
            }
            table.sau-table {
                width:100%; min-width:0 !important; max-width:100%; border-collapse:separate; border-spacing:0; table-layout:fixed;
                font-family:Verdana,Arial,Helvetica,sans-serif; font-size:10px; color:#000; background:#fff;
            }
            .sau-table th {
                position:sticky; top:0; z-index:5; height:23px; padding:3px 4px;
                background:#eaf4f1; color:#003300; border-right:1px solid #d6e3de;
                border-bottom:1px solid #b7cec5; text-align:center; font-weight:bold;
                cursor:pointer; user-select:none; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
            }
            .sau-table th.no-sort { cursor:default; }
            .sau-table td {
                padding:5px 5px; border-right:1px solid #e5ece9; border-bottom:1px solid #e5ece9;
                vertical-align:middle; text-align:center; line-height:1.25; background:#fff;
                overflow-wrap:anywhere; word-break:normal;
            }
            .sau-table tbody tr:nth-child(even) td { background:#fbfdfc; }
            .sau-table tbody tr:hover td { background:#f0f7f4 !important; }
            .sau-table tbody tr.sau-selected td { background:#e6f2ed !important; }
            .sau-table tbody tr.sau-open-row td:first-child { box-shadow:inset 3px 0 0 #b98912; }
            .sau-table tbody tr { cursor:pointer; }
            .sau-numero-cell { text-align:left !important; }
            .sau-num-top { display:flex; align-items:center; gap:4px; min-width:0; margin-bottom:2px; }
            .sau-inline-actions { display:flex; gap:2px; margin-left:auto; flex:0 0 auto; max-width:72px; }
            .sau-inline-actions .sau-mini { min-width:20px; padding:0 3px; }
            .sau-equip-cell { text-align:left !important; }
            .sau-equip-code { color:#4f625b; font-size:9px; margin-bottom:2px; }
            .sau-equip-name { color:#000; overflow-wrap:anywhere; }
            .sau-date-cell { line-height:1.35; white-space:normal; }
            .sau-status-col { white-space:normal; }

            .sau-eye { width:25px; }
            .sau-eye img { width:auto; max-width:16px; opacity:.55; }
            .sau-numero-cell { text-align:left !important; }
            .sau-numero { color:#003300 !important; text-decoration:underline !important; font-weight:bold; font-size:10px !important; }
            .sau-resumo {
                display:-webkit-box; -webkit-box-orient:vertical; overflow:hidden; margin-top:3px;
                color:#4f625c; font-size:9px; line-height:1.35; text-align:left; overflow-wrap:anywhere;
            }
            .sau-resumo.lines-1 { -webkit-line-clamp:1; }
            .sau-resumo.lines-2 { -webkit-line-clamp:2; }
            .sau-submeta { display:block; margin-top:2px; color:#6d7b76; font-size:8px; line-height:1.25; }
            .sau-status { font-weight:bold; white-space:nowrap; }
            .sau-status.andamento { color:#a36d00; }
            .sau-status.concluido { color:#006600; }
            .sau-status.nova { color:#9a6500; }
            .sau-status.outro { color:#003366; }
            .sau-sort-ind { margin-left:3px; font-size:8px; }
            .sau-empty { padding:18px !important; color:#5e6f69; text-align:center !important; }
            .sau-row-actions { display:flex; justify-content:center; gap:3px; white-space:nowrap; }
            .sau-mini {
                height:20px; padding:0 5px; border:1px solid #b7cac3; background:#fff; color:#003300;
                font:9px Verdana,Arial,sans-serif; cursor:pointer;
            }
            .sau-mini:hover { background:#eaf4f1; }

            .sau-pagination {
                display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;
                margin-top:6px; font-size:9px;
            }
            .sau-footer {
                position:fixed; left:0; right:0; bottom:0; z-index:9000;
                display:flex; align-items:center; justify-content:center; gap:8px; flex-wrap:wrap;
                box-sizing:border-box; min-height:42px; margin:0; padding:8px 12px;
                border-top:2px solid #006633; background:#eaf4f1;
                box-shadow:0 -2px 7px rgba(0,0,0,.10);
                color:#40564e; font-size:10px; line-height:1.45; text-align:center;
            }
            .sau-footer strong { color:#003300; font-size:10px; }
            .sau-footer-sep { color:#8ca097; }
            .sau-whatsapp-link {
                display:inline-flex; align-items:center; gap:5px; color:#006633 !important;
                font-size:10px !important; font-weight:bold; text-decoration:none !important;
                border-bottom:1px dotted #7fa67f; padding-bottom:1px;
            }
            .sau-whatsapp-link:hover { color:#003300 !important; border-bottom-style:solid; background:#dfeee8; }
            .sau-whatsapp-icon { width:16px; height:16px; display:inline-block; flex:0 0 16px; }
            @media (max-width:700px) {
                body.sau-enhanced-body { padding-bottom:78px !important; }
                .sau-footer { gap:5px; padding:7px 8px; font-size:9px; }
                .sau-footer strong, .sau-whatsapp-link { font-size:9px !important; }
                .sau-footer-sep { display:none; }
            }
            .sau-pages { display:flex; align-items:center; gap:3px; flex-wrap:wrap; }
            .sau-page-btn {
                min-width:24px; height:22px; padding:0 6px; border:1px solid #9eb9af; background:#f8faf9;
                color:#003300; font-family:Verdana,Arial,Helvetica,sans-serif; font-size:9px; cursor:pointer;
            }
            .sau-page-btn:hover:not(:disabled) { background:#eaf4f1; }
            .sau-page-btn.active { background:#003300; color:#fff; border-color:#003300; font-weight:bold; }
            .sau-page-btn:disabled { opacity:.4; cursor:default; }
            .sau-ellipsis { padding:0 2px; color:#50635c; }
            .sau-warn { margin:4px 0; padding:5px 7px; border:1px solid #d4bf83; background:#fffbea; color:#6d5700; font-size:9px; }

            #sau-tooltip {
                position:fixed; display:none; z-index:100000; max-width:420px; padding:6px 8px;
                border:1px solid #6b8d80; background:#fffff5; color:#111; box-shadow:1px 2px 5px rgba(0,0,0,.18);
                font:10px/1.4 Verdana,Arial,sans-serif; pointer-events:none; white-space:normal;
            }
            #sau-toast {
                position:fixed; right:14px; bottom:14px; z-index:100002; display:none;
                padding:6px 9px; border:1px solid #6f907f; background:#f4faf7; color:#003300;
                font:bold 9px Verdana,Arial,sans-serif; box-shadow:1px 2px 5px rgba(0,0,0,.15);
            }

            .sau-preview-backdrop {
                position:fixed; inset:0; z-index:99990; display:none; background:rgba(0,0,0,.08);
            }
            .sau-preview {
                position:fixed; top:0; right:0; bottom:0; z-index:99991; width:390px; max-width:92vw;
                transform:translateX(101%); transition:transform .16s ease;
                background:#fff; border-left:2px solid #006633; box-shadow:-3px 0 10px rgba(0,0,0,.18);
                font:10px Verdana,Arial,sans-serif; color:#000; display:flex; flex-direction:column;
            }
            .sau-preview.open { transform:translateX(0); }
            .sau-preview-head {
                display:flex; justify-content:space-between; align-items:center; gap:8px;
                padding:8px 10px; background:#eaf4f1; border-bottom:1px solid #b7cec5; color:#003300;
            }
            .sau-preview-title { font-weight:bold; font-size:11px; }
            .sau-preview-close { border:0; background:transparent; color:#003300; font:bold 16px Verdana; cursor:pointer; }
            .sau-preview-pager {
                display:grid; grid-template-columns:78px 1fr 78px; align-items:center; gap:6px;
                padding:5px 8px; border-bottom:1px solid #d4e1dc; background:#f9fbfa;
            }
            .sau-preview-pager button {
                height:23px; border:1px solid #9eb9af; background:#fff; color:#003300;
                font:bold 9px Verdana,Arial,sans-serif; cursor:pointer;
            }
            .sau-preview-pager button:hover:not(:disabled) { background:#eaf4f1; }
            .sau-preview-pager button:disabled { opacity:.35; cursor:default; }
            .sau-preview-position { text-align:center; color:#52645e; font-size:9px; white-space:nowrap; }
            .sau-preview-body { padding:9px 10px 16px; overflow:auto; }
            .sau-preview-grid { display:grid; grid-template-columns:105px 1fr; gap:5px 8px; align-items:start; }
            .sau-preview-label { text-align:right; color:#52645e; }
            .sau-preview-value { color:#000; overflow-wrap:anywhere; }
            .sau-preview-section { margin-top:9px; border:1px solid #d4e1dc; background:#fff; }
            .sau-preview-section-title { padding:5px 7px; background:#eaf4f1; border-bottom:1px solid #d4e1dc; color:#003300; font-weight:bold; }
            .sau-preview-section-body { padding:7px; }
            .sau-preview-box { margin-top:9px; padding:7px; border:1px solid #d4e1dc; background:#fbfdfc; line-height:1.45; }
            .sau-preview-box b { color:#003300; display:block; margin-bottom:4px; }
            .sau-preview-actions { display:flex; gap:4px; flex-wrap:wrap; margin-top:10px; }
            .sau-preview-solution-label { display:block; color:#003300; font-weight:bold; margin:0 0 4px; }
            .sau-preview-solution { width:100%; min-height:72px; box-sizing:border-box; resize:vertical; padding:5px; border:1px solid #9eb9af; background:#fff; color:#003366; font:10px/1.4 Verdana,Arial,sans-serif; }
            .sau-preview-final-row { display:flex; justify-content:space-between; align-items:center; gap:7px; flex-wrap:wrap; margin-top:6px; }
            .sau-preview-final-info { color:#64756f; font-size:9px; line-height:1.35; flex:1 1 170px; }
            .sau-preview-blocked { margin-top:6px; padding:5px 6px; border:1px solid #d7c58f; background:#fffbea; color:#745c00; font-size:9px; line-height:1.4; }
            .sau-preview-success { margin-top:6px; padding:5px 6px; border:1px solid #a8c7b7; background:#f3faf6; color:#005b2c; font-size:9px; }
            .sau-btn.finish { background:#006600; color:#fff; border-color:#005500; }
            .sau-btn.finish:hover { background:#005500; }
            .sau-btn:disabled { opacity:.55; cursor:default; }

            @media (max-width:950px) {
                #frmConsulta > div:first-of-type { grid-template-columns:100px minmax(150px,1fr) !important; }
                .sau-toolbar { grid-template-columns:minmax(220px,1fr) 150px 85px 88px; }
                .sau-actions { grid-column:1 / -1; }
                .sau-specific-grid { grid-template-columns:1fr 1fr 1fr; }
                .sau-table-wrap { max-height:62vh; overflow-x:hidden; }
            }
            @media (max-width:650px) {
                .sau-toolbar { grid-template-columns:1fr 1fr; }
                .sau-field.search { grid-column:1 / -1; }
                .sau-specific-grid { grid-template-columns:1fr 1fr; }
                .sau-actions { grid-column:1 / -1; }
                .sau-statusbar { align-items:flex-start; flex-direction:column; gap:2px; }
            }
        `;
        document.head.appendChild(style);
    }

    function ativarInterfaceMelhorada() {
        // A grade original só é escondida depois que a interface e os eventos
        // foram montados. Se a montagem falhar, a consulta legada continua visível.
        if (painelOriginal?.contains(ui.root)) form.insertBefore(ui.root, painelOriginal);
        painelOriginal?.classList.add('sau-original-panel');
        document.documentElement.classList.add('sau-enhanced');
        document.body.classList.add('sau-enhanced-body');
        tabelaOriginal.style.display = 'none';
        if (paginacaoOriginal) paginacaoOriginal.style.display = 'none';
        if (ajudaOriginal) ajudaOriginal.style.display = 'none';
        if (legendaOriginal) legendaOriginal.style.display = 'none';
    }

    // -------------------------------------------------------------------------
    // Interface
    // -------------------------------------------------------------------------

    function criarInterface() {
        const root = document.createElement('div');
        root.id = 'sau-global-ui';
        root.innerHTML = `
            <div class="sau-filter-panel">
                <div class="sau-panel-title">Pesquisa e filtros</div>
                <div class="sau-toolbar">
                    <div class="sau-field search">
                        <label for="sau-q">Pesquisar em todas as ocorrências</label>
                        <input id="sau-q" type="text" autocomplete="off" placeholder="Ex.: impressora padin, infiltração sala 13, 484897...">
                    </div>
                    <div class="sau-field">
                        <label for="sau-situacao">Situação</label>
                        <select id="sau-situacao"><option value="todas">Todas</option></select>
                    </div>
                    <div class="sau-field">
                        <label for="sau-page-size">Exibir</label>
                        <select id="sau-page-size"></select>
                    </div>
                    <div class="sau-field">
                        <label for="sau-summary-lines">Resumo</label>
                        <select id="sau-summary-lines"><option value="1">1 linha</option><option value="2">2 linhas</option></select>
                    </div>
                    <div class="sau-actions" id="sau-main-actions">
                        <button type="button" class="sau-btn" id="sau-clear-fast">Limpar filtros</button>
                        <button type="button" class="sau-btn danger-lite" id="sau-clear-all" title="Limpa também os filtros enviados ao SAU">Limpar tudo</button>
                        <button type="button" class="sau-btn primary" id="sau-refresh">Atualizar</button>
                    </div>
                </div>

                <div class="sau-specific-grid">
                    <div class="sau-server-field"><label for="txtNr">Nº</label><div id="sau-slot-numero"></div></div>
                    <div class="sau-server-field"><label for="txtEtiqueta">Etiqueta / equipamento</label><div id="sau-slot-etiqueta"></div></div>
                    <div class="sau-server-field"><label for="txtDtAbertura">Abertura</label><div id="sau-slot-abertura"></div></div>
                    <div class="sau-server-field"><label for="txtDtConclusao">Conclusão</label><div id="sau-slot-conclusao"></div></div>
                    <div class="sau-server-field"><label for="sltSecretaria">Secretaria</label><div id="sau-slot-secretaria"></div></div>
                    <div class="sau-server-field"><label for="sltDepartamento">Departamento</label><div id="sau-slot-departamento"></div></div>
                </div>

                <div class="sau-shortcuts" id="sau-shortcuts">
                <span class="sau-strip-label">Situação:</span>
                <button type="button" class="sau-chip-btn" data-status="todas">Todas <span class="count" data-count="todas"></span></button>
                <button type="button" class="sau-chip-btn status-open" data-status="pendentes">Pendentes <span class="count" data-count="pendentes"></span></button>
                <button type="button" class="sau-chip-btn status-open" data-status="em andamento">Em andamento <span class="count" data-count="em andamento"></span></button>
                <button type="button" class="sau-chip-btn status-done" data-status="concluido">Concluídas <span class="count" data-count="concluido"></span></button>
                <span class="sau-strip-label" style="margin-left:8px">Período:</span>
                <button type="button" class="sau-chip-btn" data-period="todos">Todos</button>
                <button type="button" class="sau-chip-btn" data-period="hoje">Hoje</button>
                <button type="button" class="sau-chip-btn" data-period="7">7 dias</button>
                <button type="button" class="sau-chip-btn" data-period="30">30 dias</button>
            </div>

                <div class="sau-active-filters" id="sau-active-filters"></div>
            </div>
            <div class="sau-progress-wrap" id="sau-progress-wrap"><div class="sau-progress" id="sau-progress"></div></div>
            <div class="sau-statusbar">
                <span id="sau-count"></span>
                <span id="sau-load-status"></span>
            </div>
            <div id="sau-warning"></div>

            <div class="sau-table-wrap" id="sau-table-wrap">
                <table class="sau-table">
                    <colgroup>
                        <col style="width:36%">
                        <col style="width:25%">
                        <col style="width:13%">
                        <col style="width:13%">
                        <col style="width:13%">
                    </colgroup>
                    <thead>
                        <tr>
                            <th data-sort="numero">Nº / motivo</th>
                            <th data-sort="etiqueta">Equipamento</th>
                            <th data-sort="abertura">Abertura</th>
                            <th data-sort="conclusao">Conclusão</th>
                            <th data-sort="situacao">Situação</th>
                        </tr>
                    </thead>
                    <tbody id="sau-tbody"></tbody>
                </table>
            </div>
            <div class="sau-pagination">
                <span id="sau-range"></span>
                <div class="sau-pages" id="sau-pages"></div>
            </div>
            <footer class="sau-footer" aria-label="Autoria e suporte do script">
                <span>Script de melhorias elaborado por <strong>Nilson Cruz</strong></span>
                <span class="sau-footer-sep">·</span>
                <span>Este complemento é independente e não faz parte do sistema SAU.</span>
                <span class="sau-footer-sep">·</span>
                <span>Bug ou sugestão:</span>
                <a href="https://github.com/deadidlemmo/sau-ocorrencias-userscript/issues" target="_blank" rel="noopener noreferrer">GitHub Issues</a>
            </footer>
        `;

        tabelaOriginal.insertAdjacentElement('beforebegin', root);

        // Reutiliza os campos reais do formulário legado dentro do painel unificado.
        // Assim o backend recebe exatamente os mesmos names/values de antes.
        const slots = {
            txtNr: '#sau-slot-numero',
            txtEtiqueta: '#sau-slot-etiqueta',
            txtDtAbertura: '#sau-slot-abertura',
            txtDtConclusao: '#sau-slot-conclusao',
            sltSecretaria: '#sau-slot-secretaria',
            sltDepartamento: '#sau-slot-departamento'
        };
        for (const [id, seletor] of Object.entries(slots)) {
            const el = document.getElementById(id);
            const slot = root.querySelector(seletor);
            if (el && slot) slot.appendChild(el);
        }

        const submitOriginal = form.querySelector(':scope > input[type="submit"]');
        if (submitOriginal) {
            submitOriginal.className = 'sau-btn';
            submitOriginal.value = 'Consultar no SAU';
            submitOriginal.title = 'Executa a consulta diretamente no servidor usando os filtros específicos.';
            root.querySelector('#sau-main-actions')?.prepend(submitOriginal);
        }

        const preview = document.createElement('aside');
        preview.id = 'sau-preview';
        preview.className = 'sau-preview';
        preview.setAttribute('aria-hidden', 'true');
        preview.innerHTML = `
            <div class="sau-preview-head">
                <div class="sau-preview-title" id="sau-preview-title">Prévia da ocorrência</div>
                <button type="button" class="sau-preview-close" id="sau-preview-close" title="Fechar">×</button>
            </div>
            <div class="sau-preview-pager">
                <button type="button" id="sau-preview-prev" title="Ocorrência anterior">◀ Anterior</button>
                <span class="sau-preview-position" id="sau-preview-position"></span>
                <button type="button" id="sau-preview-next" title="Próxima ocorrência">Próxima ▶</button>
            </div>
            <div class="sau-preview-body" id="sau-preview-body"></div>
        `;
        document.body.appendChild(preview);

        const tooltip = document.createElement('div');
        tooltip.id = 'sau-tooltip';
        document.body.appendChild(tooltip);

        const toast = document.createElement('div');
        toast.id = 'sau-toast';
        document.body.appendChild(toast);

        const q = root.querySelector('#sau-q');
        const situacao = root.querySelector('#sau-situacao');
        const pageSize = root.querySelector('#sau-page-size');
        const summaryLines = root.querySelector('#sau-summary-lines');

        q.value = state.pesquisa;
        for (const n of CFG.tamanhosPagina) pageSize.add(new Option(String(n), String(n), false, n === state.porPagina));
        pageSize.add(new Option('Todos', '0', false, state.porPagina === 0));
        summaryLines.value = String(state.resumoLinhas);

        q.addEventListener('input', debounce(() => {
            state.pesquisa = q.value.trim();
            state.visualizacao = '';
            state.pagina = 1;
            state.selectedIndex = -1;
            salvarEstado();
            renderizar();
        }, CFG.debounceBusca));

        situacao.addEventListener('change', () => {
            aplicarSituacao(situacao.value, true);
        });

        pageSize.addEventListener('change', () => {
            state.porPagina = Number(pageSize.value);
            state.pagina = 1;
            state.selectedIndex = -1;
            salvarEstado();
            renderizar();
        });

        summaryLines.addEventListener('change', () => {
            state.resumoLinhas = Number(summaryLines.value) === 1 ? 1 : 2;
            salvarEstado();
            renderizar();
        });

        root.querySelector('#sau-clear-fast').addEventListener('click', () => limparFiltrosRapidos());
        root.querySelector('#sau-clear-all').addEventListener('click', () => limparTudo());
        root.querySelector('#sau-refresh').addEventListener('click', () => {
            if (!state.carregando) iniciarAtualizacao();
        });

        root.querySelectorAll('[data-status]').forEach(btn => {
            btn.addEventListener('click', () => aplicarSituacao(btn.dataset.status, true));
        });
        root.querySelectorAll('[data-period]').forEach(btn => {
            btn.addEventListener('click', () => aplicarPeriodo(btn.dataset.period, true));
        });
        root.querySelectorAll('th[data-sort]').forEach(th => {
            th.addEventListener('click', () => {
                const key = th.dataset.sort;
                if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
                else {
                    state.sortKey = key;
                    state.sortDir = (key === 'numero' || key === 'abertura' || key === 'conclusao') ? 'desc' : 'asc';
                }
                state.sortManual = true;
                state.pagina = 1;
                state.selectedIndex = -1;
                salvarEstado();
                renderizar();
            });
        });

        preview.querySelector('#sau-preview-close').addEventListener('click', fecharPreview);
        preview.querySelector('#sau-preview-prev').addEventListener('click', () => navegarPreview(-1));
        preview.querySelector('#sau-preview-next').addEventListener('click', () => navegarPreview(1));

        const result = {
            root, q, situacao, pageSize, summaryLines,
            tbody: root.querySelector('#sau-tbody'),
            count: root.querySelector('#sau-count'),
            loadStatus: root.querySelector('#sau-load-status'),
            warning: root.querySelector('#sau-warning'),
            range: root.querySelector('#sau-range'),
            pages: root.querySelector('#sau-pages'),
            progressWrap: root.querySelector('#sau-progress-wrap'),
            progress: root.querySelector('#sau-progress'),
            activeFilters: root.querySelector('#sau-active-filters'),
            tableWrap: root.querySelector('#sau-table-wrap'),
            preview,
            previewTitle: preview.querySelector('#sau-preview-title'),
            previewBody: preview.querySelector('#sau-preview-body'),
            previewPrev: preview.querySelector('#sau-preview-prev'),
            previewNext: preview.querySelector('#sau-preview-next'),
            previewPosition: preview.querySelector('#sau-preview-position'),
            tooltip,
            toast
        };

        return result;
    }

    // -------------------------------------------------------------------------
    // Filtros instantâneos nos campos originais do SAU
    // -------------------------------------------------------------------------

    function lerFiltrosTopoInstantaneos() {
        const out = {};
        for (const [id] of TOP_LIVE_DEFS) {
            const el = document.getElementById(id);
            out[id] = el ? String(el.value || '').trim() : '';
        }
        return out;
    }

    function valorBaseDoCampo(id) {
        const el = document.getElementById(id);
        if (!el?.name) return '';
        return String(camposServidorBaseMap.get(el.name) || '').trim();
    }

    function restaurarFiltrosTopoDaSessao() {
        if (estadoSalvo.baseAssinatura !== assinaturaServidor || !estadoSalvo.topLive) return;
        for (const [id] of TOP_LIVE_DEFS) {
            const el = document.getElementById(id);
            if (!el) continue;
            const salvo = String(estadoSalvo.topLive[id] || '');
            // Só restaura por cima do valor-base quando estamos na mesma consulta do servidor.
            if (salvo !== String(el.value || '')) el.value = salvo;
        }
    }

    function atualizarVisualCamposTopo() {
        for (const [id] of TOP_LIVE_DEFS) {
            const el = document.getElementById(id);
            if (!el) continue;
            const atual = String(el.value || '').trim();
            const base = valorBaseDoCampo(id);
            el.classList.toggle('sau-live-field-active', !!atual && atual !== base);
        }
    }

    function instalarFiltrosTopoInstantaneos() {
        restaurarFiltrosTopoDaSessao();

        const reagir = debounce(() => {
            state.visualizacao = '';
            state.pagina = 1;
            state.selectedIndex = -1;
            atualizarVisualCamposTopo();
            salvarEstado();
            renderizar();
        }, 180);

        for (const [id] of TOP_LIVE_DEFS) {
            const el = document.getElementById(id);
            if (!el) continue;

            // Data parcial é útil para busca instantânea (ex.: 09/2026). Evita o alerta
            // legado ao sair do campo; a consulta explícita no servidor continua exigindo
            // uma data completa.
            if (id === 'txtDtAbertura' || id === 'txtDtConclusao') {
                el.removeAttribute('onblur');
                el.placeholder = 'dd/mm/aaaa';
            }
            el.setAttribute('autocomplete', 'off');
            el.addEventListener('input', reagir);
        }

        // Os dois selects dependem do servidor porque Secretaria/Departamento não vêm
        // nas linhas da grade. Ao escolher uma opção, consulta automaticamente sem exigir
        // clique no botão Consultar.
        for (const id of ['sltSecretaria', 'sltDepartamento']) {
            const el = document.getElementById(id);
            if (!el) continue;
            el.removeAttribute('onchange');
            el.onchange = null;
            el.addEventListener('change', () => {
                if (!enviarConsultaServidor()) {
                    el.value = String(camposServidorBaseMap.get(el.name) || '');
                    renderizar();
                }
            });
        }

        // Se o usuário optar por Consultar no servidor, datas parciais não devem ser
        // enviadas ao ASP legado.
        form.addEventListener('submit', ev => {
            if (!validarDatasConsulta()) ev.preventDefault();
        }, true);

        atualizarVisualCamposTopo();
    }

    function validarDatasConsulta() {
        for (const id of ['txtDtAbertura', 'txtDtConclusao']) {
            const el = document.getElementById(id);
            if (!el) continue;
            const digitos = String(el.value || '').replace(/\D/g, '');
            if (digitos && digitos.length !== 8) {
                alert('Para consultar diretamente no SAU, informe a data completa (dd/mm/aaaa). A filtragem instantânea aceita data parcial.');
                el.focus();
                return false;
            }
        }
        return true;
    }

    function enviarConsultaServidor() {
        if (!validarDatasConsulta()) return false;
        hidCurrentPage.value = '1';
        limparCache();
        salvarEstado();
        HTMLFormElement.prototype.submit.call(form);
        return true;
    }

    function dataParcialPassa(valorCampo, valorRegistro) {
        const busca = String(valorCampo || '').replace(/\D/g, '');
        if (!busca) return true;
        const reg = String(valorRegistro || '').replace(/\D/g, '');
        return !!reg && reg.includes(busca);
    }

    function filtrosTopoPassam(r) {
        const nr = String(document.getElementById('txtNr')?.value || '').replace(/\D/g, '');
        if (nr && !String(r.numero || '').includes(nr)) return false;

        const etiquetaRaw = document.getElementById('txtEtiqueta')?.value || '';
        const termosEtiqueta = norm(etiquetaRaw).split(' ').filter(Boolean);
        if (termosEtiqueta.length) {
            const alvo = norm(`${r.etiqueta || ''} ${r.codigo || ''}`);
            if (!termosEtiqueta.every(t => alvo.includes(t))) return false;
        }

        if (!dataParcialPassa(document.getElementById('txtDtAbertura')?.value, r.dtAbert)) return false;
        if (!dataParcialPassa(document.getElementById('txtDtConclusao')?.value, r.dtConc)) return false;
        return true;
    }

    function limparFiltroTopo(id) {
        const el = document.getElementById(id);
        if (!el) return;
        const tinhaFiltroNoServidor = !!valorBaseDoCampo(id);
        el.value = '';
        atualizarVisualCamposTopo();
        state.pagina = 1;
        state.selectedIndex = -1;

        if (tinhaFiltroNoServidor) {
            if (!enviarConsultaServidor()) {
                el.value = valorBaseDoCampo(id);
                atualizarVisualCamposTopo();
                renderizar();
            }
        } else {
            salvarEstado();
            renderizar();
        }
    }

    // -------------------------------------------------------------------------
    // Filtros / visualizacoes
    // -------------------------------------------------------------------------

    function atualizarSituacoes() {
        const atual = state.situacao;
        const unicas = [...new Set(state.registros.map(r => r.situacao).filter(Boolean))]
            .sort((a, b) => a.localeCompare(b, 'pt-BR'));

        ui.situacao.innerHTML = '<option value="todas">Todas</option><option value="pendentes">Pendentes (não concluídas)</option>';
        for (const label of unicas) ui.situacao.add(new Option(label, norm(label)));

        if ([...ui.situacao.options].some(o => o.value === atual)) ui.situacao.value = atual;
        else if (atual !== 'todas' && !state.carregadoCompleto) {
            ui.situacao.add(new Option(atual, atual));
            ui.situacao.value = atual;
        } else {
            state.situacao = 'todas';
            ui.situacao.value = 'todas';
        }
    }

    function aplicarSituacao(valor, limparView = false) {
        state.situacao = valor || 'todas';
        if (limparView) state.visualizacao = '';
        state.pagina = 1;
        state.selectedIndex = -1;
        aplicarOrdenacaoInteligente();
        salvarEstado();
        atualizarSituacoes();
        renderizar();
    }

    function aplicarPeriodo(valor, limparView = false) {
        state.periodo = valor || 'todos';
        if (limparView) state.visualizacao = '';
        state.pagina = 1;
        state.selectedIndex = -1;
        salvarEstado();
        renderizar();
    }

    function aplicarOrdenacaoInteligente() {
        // Ao trocar situação, prioriza o que é mais útil. O usuário pode sobrescrever clicando no cabeçalho.
        state.sortManual = false;
        if (state.situacao === 'pendentes' || state.situacao === 'em andamento') {
            state.sortKey = 'abertura';
            state.sortDir = 'asc'; // mais antigos primeiro
        } else if (state.situacao === 'concluido') {
            state.sortKey = 'conclusao';
            state.sortDir = 'desc';
        } else {
            state.sortKey = 'abertura';
            state.sortDir = 'desc'; // todas: mais recentes primeiro
        }
    }

    function aplicarVisualizacaoBuiltin(view) {
        state.visualizacao = view || '';
        state.pesquisa = '';
        ui.q.value = '';
        state.pagina = 1;
        state.selectedIndex = -1;

        switch (view) {
            case 'pendentes':
                state.situacao = 'pendentes';
                state.periodo = 'todos';
                aplicarOrdenacaoInteligente();
                break;
            case '30dias':
                state.situacao = 'todas';
                state.periodo = '30';
                state.sortKey = 'abertura';
                state.sortDir = 'desc';
                state.sortManual = false;
                break;
            case 'informatica':
            case 'manutencao':
                state.situacao = 'todas';
                state.periodo = 'todos';
                state.sortKey = 'abertura';
                state.sortDir = 'desc';
                state.sortManual = false;
                break;
        }
        atualizarSituacoes();
        salvarEstado();
        renderizar();
    }

    function limparPesquisa(focar = false) {
        state.pesquisa = '';
        state.visualizacao = '';
        state.pagina = 1;
        ui.q.value = '';
        salvarEstado();
        renderizar();
        if (focar) ui.q.focus();
    }

    function limparFiltrosRapidos() {
        state.pesquisa = '';
        state.situacao = 'todas';
        state.periodo = 'todos';
        state.visualizacao = '';
        state.pagina = 1;
        state.selectedIndex = -1;
        state.sortKey = 'abertura';
        state.sortDir = 'desc';
        state.sortManual = false;
        ui.q.value = '';

        // Nos filtros específicos instantâneos, volta ao valor que veio do servidor.
        // Ex.: se a consulta do servidor está sem Nº, apaga o Nº digitado localmente;
        // se o servidor já veio filtrado por uma data, preserva essa base.
        for (const [id] of TOP_LIVE_DEFS) {
            const el = document.getElementById(id);
            if (el) el.value = valorBaseDoCampo(id);
        }
        atualizarVisualCamposTopo();
        atualizarSituacoes();
        salvarEstado();
        renderizar();
    }

    function limparTudo() {
        state.pesquisa = '';
        state.situacao = 'todas';
        state.periodo = 'todos';
        state.visualizacao = '';
        state.pagina = 1;
        state.sortKey = 'abertura';
        state.sortDir = 'desc';
        state.sortManual = false;
        salvarEstado();
        limparCache();

        for (const id of ['txtNr', 'txtEtiqueta', 'txtDtAbertura', 'txtDtConclusao']) {
            const el = document.getElementById(id);
            if (el) el.value = '';
        }
        for (const id of ['sltSecretaria', 'sltDepartamento']) {
            const el = document.getElementById(id);
            if (el) el.value = '';
        }
        enviarConsultaServidor();
    }

    function periodoPassa(r) {
        if (state.periodo === 'todos') return true;
        if (!r.abertura) return false;
        const hoje = inicioDoDia();
        const data = inicioDoDia(r.abertura);
        if (state.periodo === 'hoje') return data === hoje;
        const dias = Number(state.periodo);
        if (!Number.isFinite(dias)) return true;
        return data >= hoje - (dias - 1) * 86400000;
    }

    function visualizacaoPassa(r) {
        if (!state.visualizacao || ['pendentes', '30dias'].includes(state.visualizacao)) return true;
        if (state.visualizacao === 'informatica' || state.visualizacao === 'manutencao') {
            return CFG.categorias[state.visualizacao].some(k => r.searchText.includes(norm(k)));
        }

        // Visualização personalizada: seus filtros já foram aplicados ao state; não adiciona regra extra.
        if (state.visualizacao.startsWith('custom:')) return true;
        return true;
    }

    function pesquisaPassa(r) {
        const termos = norm(state.pesquisa).split(' ').filter(Boolean);
        return termos.every(t => r.searchText.includes(t));
    }

    function situacaoPassa(r) {
        if (state.situacao === 'todas') return true;
        if (state.situacao === 'pendentes') return !ehConcluido(r);
        if (state.situacao === 'em andamento') return ehEmAndamento(r);
        if (state.situacao === 'concluido') return ehConcluido(r);
        return r.situacaoNorm === state.situacao;
    }

    function getServerFilters() {
        const defs = [['sltSecretaria', 'Secretaria'], ['sltDepartamento', 'Departamento']];
        const out = [];
        for (const [id, label] of defs) {
            const el = document.getElementById(id);
            if (!el || !String(el.value || '').trim()) continue;
            const valueLabel = (el.options[el.selectedIndex]?.text || el.value).trim();
            if (!valueLabel) continue;
            out.push({ id, label, value: valueLabel });
        }
        return out;
    }

    function getTopLiveFilters() {
        const out = [];
        for (const [id, label] of TOP_LIVE_DEFS) {
            const el = document.getElementById(id);
            const value = String(el?.value || '').trim();
            if (value) out.push({ id, label, value });
        }
        return out;
    }

    function removerFiltroServidor(id) {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = '';
        if (!enviarConsultaServidor()) {
            el.value = String(camposServidorBaseMap.get(el.name) || '');
            renderizar();
        }
    }

    function renderFiltrosAtivos() {
        const tags = [];
        if (state.pesquisa) tags.push({ tipo:'pesquisa', label:`Pesquisa: “${state.pesquisa}”` });
        if (state.situacao !== 'todas') {
            const rotulo = state.situacao === 'pendentes'
                ? 'Pendentes'
                : ([...ui.situacao.options].find(o => o.value === state.situacao)?.text || state.situacao);
            tags.push({ tipo:'situacao', label:`Situação: ${rotulo}` });
        }
        if (state.periodo !== 'todos') {
            const p = { hoje:'Hoje', '7':'Últimos 7 dias', '30':'Últimos 30 dias' }[state.periodo] || state.periodo;
            tags.push({ tipo:'periodo', label:`Período: ${p}` });
        }

        const liveTop = getTopLiveFilters();
        const server = getServerFilters();
        ui.activeFilters.innerHTML = '';
        if (!tags.length && !liveTop.length && !server.length) {
            ui.activeFilters.style.display = 'none';
            return;
        }
        ui.activeFilters.style.display = 'flex';

        const label = document.createElement('span');
        label.className = 'sau-strip-label';
        label.textContent = 'Filtros ativos:';
        ui.activeFilters.appendChild(label);

        for (const tag of tags) {
            const el = document.createElement('span');
            el.className = 'sau-filter-tag';
            el.innerHTML = `${escapeHtml(tag.label)} <button type="button" title="Remover">×</button>`;
            el.querySelector('button').addEventListener('click', () => {
                if (tag.tipo === 'pesquisa') { state.pesquisa = ''; ui.q.value = ''; }
                if (tag.tipo === 'situacao') state.situacao = 'todas';
                if (tag.tipo === 'periodo') state.periodo = 'todos';
                state.pagina = 1;
                atualizarSituacoes();
                salvarEstado();
                renderizar();
            });
            ui.activeFilters.appendChild(el);
        }

        for (const lf of liveTop) {
            const el = document.createElement('span');
            el.className = 'sau-filter-tag';
            el.innerHTML = `${escapeHtml(lf.label)}: ${escapeHtml(lf.value)} <button type="button" title="Remover filtro instantâneo">×</button>`;
            el.querySelector('button').addEventListener('click', () => limparFiltroTopo(lf.id));
            ui.activeFilters.appendChild(el);
        }

        for (const sf of server) {
            const el = document.createElement('span');
            el.className = 'sau-filter-tag server';
            el.innerHTML = `SAU ${escapeHtml(sf.label)}: ${escapeHtml(sf.value)} <button type="button" title="Remover filtro do SAU">×</button>`;
            el.querySelector('button').addEventListener('click', () => removerFiltroServidor(sf.id));
            ui.activeFilters.appendChild(el);
        }
    }

    function atualizarContadoresRapidos() {
        const counts = {
            todas: state.registros.length,
            pendentes: state.registros.filter(r => !ehConcluido(r)).length,
            'em andamento': state.registros.filter(ehEmAndamento).length,
            concluido: state.registros.filter(ehConcluido).length
        };
        ui.root.querySelectorAll('[data-count]').forEach(span => {
            const v = counts[span.dataset.count] ?? 0;
            span.textContent = `(${v})`;
        });
    }

    function atualizarBotoesAtivos() {
        ui.root.querySelectorAll('[data-status]').forEach(b => b.classList.toggle('active', b.dataset.status === state.situacao));
        ui.root.querySelectorAll('[data-period]').forEach(b => b.classList.toggle('active', b.dataset.period === state.periodo));
    }

    // -------------------------------------------------------------------------
    // Minhas visualizacoes personalizadas
    // -------------------------------------------------------------------------

    function carregarViews() {
        const x = carregarJSON(localStorage, CFG.viewsKey, []);
        return Array.isArray(x) ? x : [];
    }

    function salvarViews(v) {
        try { localStorage.setItem(CFG.viewsKey, JSON.stringify(v)); } catch (_) {}
    }

    function salvarVisualizacaoAtual() {
        const nome = prompt('Nome para esta visualização:');
        if (!nome || !nome.trim()) return;
        const nomeLimpo = nome.trim().slice(0, 40);
        let views = carregarViews().filter(v => v.nome !== nomeLimpo);
        views.push({
            nome: nomeLimpo,
            pesquisa: state.pesquisa,
            situacao: state.situacao,
            periodo: state.periodo,
            porPagina: state.porPagina,
            resumoLinhas: state.resumoLinhas,
            sortKey: state.sortKey,
            sortDir: state.sortDir
        });
        salvarViews(views.slice(-12));
        renderCustomViews(ui);
        mostrarToast(`Visualização “${nomeLimpo}” salva.`);
    }

    function renderCustomViews(targetUi) {
        if (!targetUi?.customViews) return;
        targetUi.customViews.innerHTML = '';
        for (const v of carregarViews()) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'sau-chip-btn';
            btn.dataset.customView = v.nome;
            btn.innerHTML = `${escapeHtml(v.nome)} <span class="sau-view-remove" title="Excluir visualização">×</span>`;
            btn.addEventListener('click', (ev) => {
                if (ev.target.classList.contains('sau-view-remove')) {
                    ev.stopPropagation();
                    const views = carregarViews().filter(x => x.nome !== v.nome);
                    salvarViews(views);
                    renderCustomViews(targetUi);
                    atualizarBotoesAtivos();
                    return;
                }
                state.visualizacao = `custom:${v.nome}`;
                state.pesquisa = v.pesquisa || '';
                state.situacao = v.situacao || 'todas';
                state.periodo = v.periodo || 'todos';
                state.porPagina = Number(v.porPagina) || CFG.tamanhoPadrao;
                state.resumoLinhas = Number(v.resumoLinhas) === 1 ? 1 : 2;
                state.sortKey = v.sortKey || 'abertura';
                state.sortDir = v.sortDir === 'asc' ? 'asc' : 'desc';
                state.sortManual = true;
                state.pagina = 1;
                state.selectedIndex = -1;
                ui.q.value = state.pesquisa;
                ui.pageSize.value = String(state.porPagina);
                ui.summaryLines.value = String(state.resumoLinhas);
                atualizarSituacoes();
                salvarEstado();
                renderizar();
            });
            targetUi.customViews.appendChild(btn);
        }
    }

    // -------------------------------------------------------------------------
    // Ordenacao, filtragem e renderizacao
    // -------------------------------------------------------------------------

    function classeSituacao(s) {
        const n = norm(s);
        if (n.includes('conclu')) return 'concluido';
        if (n.includes('andamento')) return 'andamento';
        if (n.includes('nova')) return 'nova';
        return 'outro';
    }

    function registrosFiltradosOrdenados() {
        let arr = state.registros.filter(r => filtrosTopoPassam(r) && situacaoPassa(r) && periodoPassa(r) && pesquisaPassa(r));

        const mult = state.sortDir === 'asc' ? 1 : -1;
        arr.sort((a, b) => {
            let va, vb;
            switch (state.sortKey) {
                case 'numero': va = Number(a.numero) || 0; vb = Number(b.numero) || 0; break;
                case 'codigo': va = norm(a.codigo); vb = norm(b.codigo); break;
                case 'etiqueta': va = norm(a.etiqueta); vb = norm(b.etiqueta); break;
                case 'abertura': va = a.abertura; vb = b.abertura; break;
                case 'conclusao': va = a.conclusao; vb = b.conclusao; break;
                case 'situacao': va = a.situacaoNorm; vb = b.situacaoNorm; break;
                default: va = a.abertura; vb = b.abertura;
            }
            let cmp = 0;
            if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
            else cmp = String(va).localeCompare(String(vb), 'pt-BR', { numeric:true, sensitivity:'base' });
            if (cmp === 0) cmp = (Number(a.numero) || 0) - (Number(b.numero) || 0);
            return cmp * mult;
        });
        return arr;
    }

    function renderizar() {
        atualizarCabecalhoOrdenacao();
        atualizarContadoresRapidos();
        atualizarBotoesAtivos();
        renderFiltrosAtivos();

        const filtrados = registrosFiltradosOrdenados();
        const total = filtrados.length;
        const porPagina = state.porPagina === 0 ? Math.max(total, 1) : state.porPagina;
        const totalPaginas = Math.max(1, Math.ceil(total / porPagina));
        if (state.pagina > totalPaginas) state.pagina = totalPaginas;
        if (state.pagina < 1) state.pagina = 1;

        const inicio = total === 0 ? 0 : (state.pagina - 1) * porPagina;
        const fim = state.porPagina === 0 ? total : Math.min(inicio + porPagina, total);
        const paginaRegs = filtrados.slice(inicio, fim);

        ui.tbody.innerHTML = '';
        if (!paginaRegs.length) {
            const tr = document.createElement('tr');
            tr.innerHTML = '<td colspan="5" class="sau-empty">Nenhuma ocorrência encontrada com os filtros atuais.</td>';
            ui.tbody.appendChild(tr);
        } else {
            const frag = document.createDocumentFragment();
            for (let idx = 0; idx < paginaRegs.length; idx++) {
                const r = paginaRegs[idx];
                try {
                    frag.appendChild(criarLinha(r, idx));
                } catch (erroLinha) {
                    console.error('[SAU QOL] Falha ao renderizar ocorrência', r?.numero, erroLinha);
                    const tr = document.createElement('tr');
                    tr.dataset.numero = r?.numero || '';
                    tr.innerHTML = `
                        <td class="sau-numero-cell"><a class="sau-numero" href="${escapeAttr(r?.detalheUrl || '#')}">${escapeHtml(r?.numero || '-')}</a><div class="sau-resumo lines-2">${escapeHtml(r?.motivo || 'Sem descrição disponível.')}</div></td>
                        <td>${escapeHtml(r?.codigo || '-')}<br>${escapeHtml(r?.etiqueta || '-')}</td>
                        <td>${escapeHtml(r?.dtAbert || '-')}<br>${escapeHtml(r?.hrAbert || '')}</td>
                        <td>${escapeHtml(r?.dtConc || '-')}<br>${escapeHtml(r?.hrConc || '')}</td>
                        <td>${escapeHtml(r?.situacao || '-')}</td>`;
                    frag.appendChild(tr);
                }
            }
            ui.tbody.appendChild(frag);
        }

        const confirmadas = state.paginasConfirmadas.size;
        const hora = state.atualizadoEm ? ` · Atualizado às ${formatarHora(state.atualizadoEm)}` : '';
        let carregamento;
        if (state.atualizando) {
            const p = state.progressoAtualizacao;
            carregamento = `Atualizando histórico ${p?.carregadas || 0}/${p?.total || '?'} páginas · exibindo a lista anterior até confirmar a atualização`;
        } else if (state.carregando) {
            carregamento = `Carregando ${confirmadas}/${state.totalPaginasServidor} páginas · ${state.registros.length} ocorrências${hora}`;
        } else if (state.carregadoCompleto) {
            carregamento = `${confirmadas}/${state.totalPaginasServidor} páginas carregadas · ${state.registros.length} ocorrências${hora}${state.cacheRestaurado ? ' · cache da sessão' : ''}`;
        } else {
            carregamento = `${confirmadas}/${state.totalPaginasServidor} páginas carregadas · ${state.paginasComErro.length} falha(s)${hora}`;
        }

        ui.count.textContent = `${total} ocorrência${total === 1 ? '' : 's'} encontrada${total === 1 ? '' : 's'}${state.carregadoCompleto && !state.atualizando ? '' : ' até agora'}`;
        ui.loadStatus.textContent = carregamento;
        ui.loadStatus.classList.toggle('sau-load-incomplete', !state.carregando && !state.carregadoCompleto && state.paginasComErro.length > 0);
        ui.range.textContent = total ? `Exibindo ${inicio + 1}-${fim} de ${total} · Página ${state.pagina} de ${totalPaginas}` : 'Exibindo 0 de 0';

        renderPaginacao(totalPaginas);
        renderAviso();
        if (state.previewNumero) {
            const atualPreview = state.registrosPorNumero.get(String(state.previewNumero));
            if (atualPreview) atualizarPaginadorPreview(atualPreview);
        }
        salvarEstado();
    }

    function criarLinha(r, visibleIndex) {
        // Renderização deliberadamente simples: monta somente o HTML da linha.
        // Os eventos são tratados por delegação no <tbody>, o que evita que um
        // botão/elemento inesperado em uma linha interrompa a renderização de toda a grade.
        const tr = document.createElement('tr');
        tr.dataset.numero = r.numero;
        tr.dataset.visibleIndex = String(visibleIndex);
        if (!ehConcluido(r)) tr.classList.add('sau-open-row');
        if (visibleIndex === state.selectedIndex) tr.classList.add('sau-selected');

        const motivo = r.motivo || 'Sem descrição disponível.';
        const tempo = formatarTempoAberto(r);
        const conclusao = r.dtConc && r.dtConc !== '-'
            ? `${escapeHtml(r.dtConc)}${r.hrConc && r.hrConc !== '-' ? `<br>${escapeHtml(r.hrConc)}` : ''}`
            : '-';

        tr.innerHTML = `
            <td class="sau-numero-cell">
                <div class="sau-num-top">
                    <a href="${escapeAttr(r.detalheUrl)}" class="sau-numero" data-cd="${escapeAttr(r.numero)}">${escapeHtml(r.numero)}</a>
                    <span class="sau-inline-actions">
                        <button type="button" class="sau-mini" data-action="copy-number" title="Copiar número">Nº</button>
                        <button type="button" class="sau-mini" data-action="copy-summary" title="Copiar resumo">⧉</button>
                        <button type="button" class="sau-mini" data-action="new-tab" title="Abrir em nova aba">↗</button>
                    </span>
                </div>
                <div class="sau-resumo lines-${state.resumoLinhas}" data-tooltip="${escapeAttr(motivo)}">${escapeHtml(motivo)}</div>
            </td>
            <td class="sau-equip-cell">
                <div class="sau-equip-code">Código: ${escapeHtml(r.codigo || '-')}</div>
                <div class="sau-equip-name">${escapeHtml(r.etiqueta || '-')}</div>
            </td>
            <td class="sau-date-cell">${escapeHtml(r.dtAbert || '-')}${r.hrAbert && r.hrAbert !== '-' ? `<br>${escapeHtml(r.hrAbert)}` : ''}</td>
            <td class="sau-date-cell">${conclusao}</td>
            <td class="sau-status-col">
                <span class="sau-status ${classeSituacao(r.situacao)}">${escapeHtml(r.situacao || '-')}</span>
                ${tempo ? `<span class="sau-submeta">${escapeHtml(tempo)}</span>` : ''}
            </td>
        `;
        return tr;
    }

    function instalarEventosTabela() {
        let clickTimer = null;

        const obterRegistro = (target) => {
            const tr = target?.closest?.('tr[data-numero]');
            if (!tr) return null;
            return state.registrosPorNumero.get(tr.dataset.numero) || null;
        };

        ui.tbody.addEventListener('click', ev => {
            const r = obterRegistro(ev.target);
            if (!r) return;

            const acao = ev.target.closest?.('[data-action]')?.dataset?.action;
            if (acao) {
                ev.preventDefault();
                ev.stopPropagation();
                if (acao === 'copy-number') copiarTexto(r.numero, 'Número copiado.');
                if (acao === 'copy-summary') copiarTexto(resumoOcorrencia(r), 'Resumo copiado.');
                if (acao === 'new-tab') abrirNovaAba(r);
                return;
            }

            if (window.getSelection?.()?.toString()) return;
            if (ev.ctrlKey || ev.metaKey) {
                ev.preventDefault();
                abrirNovaAba(r);
                return;
            }

            if (ev.target.closest?.('a.sau-numero')) ev.preventDefault();
            clearTimeout(clickTimer);
            clickTimer = setTimeout(() => abrirPreview(r), 180);
        });

        ui.tbody.addEventListener('dblclick', ev => {
            const r = obterRegistro(ev.target);
            if (!r || ev.target.closest?.('[data-action]')) return;
            clearTimeout(clickTimer);
            ev.preventDefault();
            abrirDetalhe(r);
        });
    }

    function resumoOcorrencia(r) {
        return `Ocorrência ${r.numero} - ${r.situacao || 'Sem situação'} - ${r.motivo || 'Sem descrição'}`;
    }

    function atualizarCabecalhoOrdenacao() {
        ui.root.querySelectorAll('th[data-sort]').forEach(th => {
            th.querySelector('.sau-sort-ind')?.remove();
            if (th.dataset.sort === state.sortKey) {
                const span = document.createElement('span');
                span.className = 'sau-sort-ind';
                span.textContent = state.sortDir === 'asc' ? '▲' : '▼';
                th.appendChild(span);
            }
        });
    }

    // -------------------------------------------------------------------------
    // Paginacao propria
    // -------------------------------------------------------------------------

    function renderPaginacao(totalPaginas) {
        ui.pages.innerHTML = '';

        const addBtn = (label, page, disabled = false, active = false, title = '') => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'sau-page-btn' + (active ? ' active' : '');
            b.textContent = label;
            b.disabled = disabled;
            if (title) b.title = title;
            b.addEventListener('click', () => {
                state.pagina = page;
                state.selectedIndex = -1;
                salvarEstado();
                renderizar();
                ui.tableWrap.scrollTo({ top:0, behavior:'smooth' });
            });
            ui.pages.appendChild(b);
        };

        addBtn('«', 1, state.pagina <= 1, false, 'Primeira página');
        addBtn('‹', Math.max(1, state.pagina - 1), state.pagina <= 1, false, 'Página anterior');

        const nums = paginasParaMostrar(state.pagina, totalPaginas);
        let anterior = null;
        for (const p of nums) {
            if (anterior !== null && p - anterior > 1) {
                const e = document.createElement('span');
                e.className = 'sau-ellipsis'; e.textContent = '…'; ui.pages.appendChild(e);
            }
            addBtn(String(p), p, false, p === state.pagina);
            anterior = p;
        }

        addBtn('›', Math.min(totalPaginas, state.pagina + 1), state.pagina >= totalPaginas, false, 'Próxima página');
        addBtn('»', totalPaginas, state.pagina >= totalPaginas, false, 'Última página');
    }

    function paginasParaMostrar(atual, total) {
        if (total <= 9) return Array.from({ length: total }, (_, i) => i + 1);
        const set = new Set([1, 2, total - 1, total]);
        for (let p = atual - 2; p <= atual + 2; p++) if (p >= 1 && p <= total) set.add(p);
        return [...set].sort((a, b) => a - b);
    }

    // -------------------------------------------------------------------------
    // Preview / detalhe / copiar / tooltip
    // -------------------------------------------------------------------------

    function abrirDetalhe(r) {
        salvarEstado();
        const url = r.detalheUrl;
        if (typeof window.abreDetalhe === 'function') window.abreDetalhe(url);
        else window.open(url, 'detalhe', 'width=480,height=620,top=40,left=60,scrollbars=yes,resizable=yes');
    }

    function abrirNovaAba(r) {
        salvarEstado();
        window.open(new URL(r.detalheUrl, location.href).href, '_blank', 'noopener');
    }

    function listaNavegacaoPreview() {
        // Usa exatamente a mesma lista filtrada/ordenada exibida na grade, mas sem
        // limitar à página visual atual. Assim as setas percorrem todo o resultado.
        return registrosFiltradosOrdenados();
    }

    function atualizarPaginadorPreview(r) {
        if (!ui?.previewPrev || !ui?.previewNext || !ui?.previewPosition) return;
        const lista = listaNavegacaoPreview();
        const idx = lista.findIndex(x => String(x.numero) === String(r?.numero));
        const encontrado = idx >= 0;
        ui.previewPrev.disabled = !encontrado || idx <= 0;
        ui.previewNext.disabled = !encontrado || idx >= lista.length - 1;
        ui.previewPosition.textContent = encontrado
            ? `${idx + 1} de ${lista.length} ocorrências`
            : 'Ocorrência fora do filtro atual';
    }

    function navegarPreview(delta) {
        if (!state.previewNumero || !delta) return;
        const lista = listaNavegacaoPreview();
        const idx = lista.findIndex(x => String(x.numero) === String(state.previewNumero));
        if (idx < 0) return;
        const novoIdx = idx + delta;
        if (novoIdx < 0 || novoIdx >= lista.length) return;

        const proxima = lista[novoIdx];

        // Mantém a paginação da grade sincronizada com a ocorrência aberta no painel.
        if (state.porPagina > 0) {
            const novaPagina = Math.floor(novoIdx / state.porPagina) + 1;
            if (state.pagina !== novaPagina) {
                state.pagina = novaPagina;
                state.selectedIndex = novoIdx % state.porPagina;
                renderizar();
            } else {
                state.selectedIndex = novoIdx % state.porPagina;
            }
        }

        abrirPreview(proxima);
    }

    async function abrirPreview(r) {
        state.previewNumero = r.numero;
        ui.preview.classList.add('open');
        ui.preview.setAttribute('aria-hidden', 'false');
        ui.previewTitle.textContent = `Ocorrência nº ${r.numero}`;
        atualizarPaginadorPreview(r);

        ui.previewBody.innerHTML = previewHtml(r, null, true);
        ligarAcoesPreview(r, null);

        try {
            const detalhe = await carregarDetalhes(r);
            if (state.previewNumero !== r.numero) return;
            ui.previewBody.innerHTML = previewHtml(r, detalhe, false);
            ligarAcoesPreview(r, detalhe);
        } catch (e) {
            if (state.previewNumero !== r.numero) return;
            ui.previewBody.innerHTML = previewHtml(r, { erro: true }, false);
            ligarAcoesPreview(r, null);
            console.warn('[SAU QOL] Falha no preview:', e);
        }
    }

    function fecharPreview() {
        state.previewNumero = null;
        ui.preview.classList.remove('open');
        ui.preview.setAttribute('aria-hidden', 'true');
    }

    function motivoBloqueioConclusao(r, d) {
        if (state.conclusoesSemConfirmacao.has(r.numero)) return 'Houve um envio sem confirmação. Abra a ocorrência no SAU e confira o status antes de tentar novamente.';
        if (!d || d.erro) return 'Os dados de edição não puderam ser carregados.';
        if (ehConcluido(r) || d.statusCode === '3') return 'Esta ocorrência já está concluída.';
        if (!d.editavel || !d.podeConcluir || !d.formActionMesmoDominio) return 'O SAU não liberou a conclusão desta ocorrência para este usuário/tela.';
        if (!d.setorId) return 'A ocorrência está sem setor definido. Abra a ocorrência para ajustar o setor antes de concluir.';
        if (!d.tecnico1) return 'A ocorrência está sem técnico definido. Abra a ocorrência para ajustar o técnico antes de concluir.';
        if (d.tecnico2 && d.tecnico1 === d.tecnico2) return 'Os dois técnicos estão iguais; o próprio SAU não permite concluir nessa condição.';
        if (d.pendente) return 'A ocorrência está marcada como Pendente. Remova esse status antes de concluir.';
        if (d.emVerificacao) return 'A ocorrência está marcada como Em verificação. Remova esse status antes de concluir.';
        return '';
    }

    function previewHtml(r, d, loading) {
        const tempo = d?.statusCode === '3' ? '' : formatarTempoAberto(r);
        const situacaoExibida = d?.statusCode === '3' ? 'Concluído' : r.situacao;
        const setor = loading ? 'Carregando...' : (d?.setor || '-');
        const tecnico = loading ? 'Carregando...' : (d?.tecnico || '-');
        const solicitante = loading ? '' : (d?.solicitante || '');
        const ramal = loading ? '' : (d?.ramal || '');
        const bloqueio = loading ? '' : motivoBloqueioConclusao(r, d);
        const podeFinalizar = !loading && !bloqueio && !ehConcluido(r);
        const solucaoAtual = loading ? 'Carregando...' : (d?.solucao || '');

        const atendimento = ehConcluido(r) || d?.statusCode === '3'
            ? `<div class="sau-preview-box"><b>Solução</b>${escapeHtml(solucaoAtual || 'Não informada.')}</div>`
            : `
                <div class="sau-preview-section">
                    <div class="sau-preview-section-title">Atendimento</div>
                    <div class="sau-preview-section-body">
                        <label class="sau-preview-solution-label" for="sau-preview-solution">Solução / providência</label>
                        <textarea id="sau-preview-solution" class="sau-preview-solution" maxlength="800" ${podeFinalizar ? '' : 'disabled'} placeholder="Descreva a solução realizada antes de concluir a ocorrência...">${escapeHtml(d?.solucao || '')}</textarea>
                        ${loading ? '<div class="sau-preview-final-info" style="margin-top:5px">Carregando permissões e dados da ocorrência...</div>' : ''}
                        ${!loading && bloqueio ? `<div class="sau-preview-blocked">${escapeHtml(bloqueio)}</div>` : ''}
                        ${podeFinalizar ? `
                            <div class="sau-preview-final-row">
                                <div class="sau-preview-final-info">Ao concluir, o script envia ao SAU os mesmos campos da tela original e exige confirmação antes do envio.</div>
                                <button class="sau-btn finish" type="button" data-preview-action="finish">Concluir ocorrência</button>
                            </div>` : ''}
                        <div id="sau-preview-finish-result"></div>
                    </div>
                </div>`;

        return `
            <div class="sau-preview-section" style="margin-top:0">
                <div class="sau-preview-section-title">Dados da ocorrência</div>
                <div class="sau-preview-section-body">
                    <div class="sau-preview-grid">
                        <div class="sau-preview-label">Situação:</div><div class="sau-preview-value"><b>${escapeHtml(situacaoExibida || '-')}</b>${tempo ? ` · ${escapeHtml(tempo)}` : ''}</div>
                        <div class="sau-preview-label">Equipamento:</div><div class="sau-preview-value">${escapeHtml(r.etiqueta || '-')}</div>
                        <div class="sau-preview-label">Código:</div><div class="sau-preview-value">${escapeHtml(r.codigo || '-')}</div>
                        <div class="sau-preview-label">Abertura:</div><div class="sau-preview-value">${escapeHtml(`${r.dtAbert || '-'} ${r.hrAbert || ''}`.trim())}</div>
                        <div class="sau-preview-label">Conclusão:</div><div class="sau-preview-value">${escapeHtml(`${r.dtConc || '-'} ${r.hrConc || ''}`.trim())}</div>
                        <div class="sau-preview-label">Setor:</div><div class="sau-preview-value">${escapeHtml(setor)}</div>
                        <div class="sau-preview-label">Técnico:</div><div class="sau-preview-value">${escapeHtml(tecnico)}</div>
                        ${solicitante ? `<div class="sau-preview-label">Solicitante:</div><div class="sau-preview-value">${escapeHtml(solicitante)}${ramal ? ` · Ramal ${escapeHtml(ramal)}` : ''}</div>` : ''}
                    </div>
                </div>
            </div>
            <div class="sau-preview-box"><b>Motivo</b>${escapeHtml(r.motivo || 'Sem descrição disponível.')}</div>
            ${d?.erro ? '<div class="sau-preview-blocked">Não foi possível carregar os dados adicionais desta ocorrência. As opções de edição foram desativadas.</div>' : atendimento}
            <div class="sau-preview-actions">
                <button class="sau-btn primary" type="button" data-preview-action="new-tab">Abrir em nova aba ↗</button>
                <button class="sau-btn" type="button" data-preview-action="copy-number">Copiar nº</button>
                <button class="sau-btn" type="button" data-preview-action="copy-summary">Copiar resumo</button>
            </div>
        `;
    }

    function ligarAcoesPreview(r, detalhe) {
        ui.previewBody.querySelector('[data-preview-action="new-tab"]')?.addEventListener('click', () => abrirNovaAba(r));
        ui.previewBody.querySelector('[data-preview-action="copy-number"]')?.addEventListener('click', () => copiarTexto(r.numero, 'Número copiado.'));
        ui.previewBody.querySelector('[data-preview-action="copy-summary"]')?.addEventListener('click', () => copiarTexto(resumoOcorrencia(r), 'Resumo copiado.'));
        ui.previewBody.querySelector('[data-preview-action="finish"]')?.addEventListener('click', () => finalizarOcorrenciaInline(r, detalhe));
    }

    function capturarCamposFormularioDetalhe(formDetalhe) {
        const campos = [];
        if (!formDetalhe?.elements) return campos;
        for (const el of [...formDetalhe.elements]) {
            if (!el?.name || el.disabled) continue;
            const type = String(el.type || '').toLowerCase();
            if (['button', 'submit', 'reset', 'file', 'image'].includes(type)) continue;
            if ((type === 'checkbox' || type === 'radio') && !el.checked) continue;
            if (el.tagName === 'SELECT' && el.multiple) {
                for (const opt of [...el.options].filter(o => o.selected)) campos.push([el.name, opt.value]);
            } else {
                campos.push([el.name, String(el.value ?? '')]);
            }
        }
        return campos;
    }

    async function carregarDetalhes(r, forcarAtualizacao = false) {
        if (!forcarAtualizacao && state.detalhesCache.has(r.numero)) return state.detalhesCache.get(r.numero);

        const resp = await fetch(new URL(r.detalheUrl, location.href).href, {
            method:'GET', credentials:'same-origin', cache:'no-store'
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = await resp.arrayBuffer();
        let html;
        try { html = new TextDecoder('windows-1252').decode(buf); }
        catch (_) { html = new TextDecoder().decode(buf); }
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const formDetalhe = doc.querySelector('form[name="form1"]') || doc.querySelector('form[action*="ocorr_detalhes.asp"]');
        const botaoAtualizar = formDetalhe?.querySelector('[name="atualizar"]');
        const campoSolucao = formDetalhe?.querySelector('[name="txtSolucao"]');
        const campoConcluir = formDetalhe?.querySelector('[name="chkConcluir"]');
        const formAction = new URL(formDetalhe?.getAttribute('action') || r.detalheUrl, location.href);

        const val = name => formDetalhe?.querySelector(`[name="${name}"]`)?.value?.trim() || doc.querySelector(`[name="${name}"]`)?.value?.trim() || '';
        const sltSetor = formDetalhe?.querySelector('[name="sltSetor"]');
        const setorId = sltSetor?.value?.trim() || '';
        const setorTexto = sltSetor && sltSetor.selectedIndex >= 0
            ? (sltSetor.options[sltSetor.selectedIndex]?.text || '').trim()
            : '';
        const tecnico1 = val('sltTecnico') || val('hidTecnico');
        const tecnico2 = val('sltTecnico2') || val('hidTecnico2');
        const statusCode = val('CD_STATUS');

        const detalhe = {
            solucao: val('txtSolucao') || val('hidSolucao'),
            setorId,
            setor: setorTexto || val('hidSetor'),
            tecnico1,
            tecnico2,
            tecnico: [tecnico1, tecnico2].filter(Boolean).join(' / '),
            solicitante: val('hidSolicitante'),
            ramal: val('hidRamal'),
            statusCode,
            pendente: !!formDetalhe?.querySelector('[name="chkExterno"]')?.checked,
            emVerificacao: !!formDetalhe?.querySelector('[name="chkTransp"]')?.checked,
            editavel: !!botaoAtualizar && !botaoAtualizar.disabled && !!campoSolucao && !campoSolucao.disabled,
            podeConcluir: !!campoConcluir && !campoConcluir.disabled,
            formAction: formAction.href,
            formActionMesmoDominio: formAction.origin === location.origin,
            submitField: botaoAtualizar && String(botaoAtualizar.type || '').toLowerCase() === 'submit'
                ? [botaoAtualizar.name, botaoAtualizar.value]
                : null,
            formFields: capturarCamposFormularioDetalhe(formDetalhe)
        };
        state.detalhesCache.set(r.numero, detalhe);
        return detalhe;
    }

    async function finalizarOcorrenciaInline(r, detalhe) {
        if (!detalhe) return;
        const bloqueio = motivoBloqueioConclusao(r, detalhe);
        if (bloqueio) {
            alert(bloqueio);
            return;
        }

        const textarea = ui.previewBody.querySelector('#sau-preview-solution');
        const solucao = String(textarea?.value || '').trim();
        if (!solucao) {
            alert('Informe a solução/providência antes de concluir a ocorrência.');
            textarea?.focus();
            return;
        }
        if (solucao.length > 800) {
            alert('A solução deve ter no máximo 800 caracteres.');
            textarea?.focus();
            return;
        }

        const confirmar = confirm(`Concluir a ocorrência nº ${r.numero}?\n\nSolução:\n${solucao}\n\nA ação será enviada diretamente ao SAU.`);
        if (!confirmar) return;

        const btn = ui.previewBody.querySelector('[data-preview-action="finish"]');
        if (btn) { btn.disabled = true; btn.textContent = 'Concluindo...'; }
        let envioIniciado = false;

        try {
            // A prévia pode estar aberta há muito tempo. Reconsulta o SAU imediatamente
            // antes do POST e usa apenas os campos e permissões mais recentes.
            const detalheAtual = await carregarDetalhes(r, true);
            const bloqueioAtual = motivoBloqueioConclusao(r, detalheAtual);
            if (bloqueioAtual) throw new Error(bloqueioAtual);

            envioIniciado = true;
            const retorno = await submeterConclusaoNativa(r, detalheAtual, solucao);
            if (retorno.statusCode !== '3') {
                throw new Error(`O SAU respondeu com status ${retorno.statusCode || 'desconhecido'} e não confirmou a conclusão.`);
            }
            const detalheConfirmado = await carregarDetalhes(r, true);
            if (detalheConfirmado.statusCode !== '3') {
                throw new Error('A resposta do envio indicou conclusão, mas uma nova consulta ao SAU não confirmou o status. Verifique a ocorrência antes de tentar novamente.');
            }
            state.conclusoesSemConfirmacao.delete(r.numero);
            limparCache();
            // Cancela uma carga inicial em andamento antes de buscar a lista nova.
            if (state.carregando) {
                state.geracaoCarga++;
                state.carregando = false;
            }
            if (state.atualizacaoPromise) await state.atualizacaoPromise;
            const listaAtualizada = await iniciarAtualizacao();
            const registroAtual = listaAtualizada ? state.registrosPorNumero.get(r.numero) : null;
            const registroPreview = registroAtual || reidratarRegistro({ ...r, situacao: 'Concluído' });
            if (state.previewNumero === r.numero) {
                ui.previewBody.innerHTML = previewHtml(registroPreview, detalheConfirmado, false);
                ligarAcoesPreview(registroPreview, detalheConfirmado);
                const ok = document.createElement('div');
                ok.className = 'sau-preview-success';
                ok.textContent = listaAtualizada
                    ? 'Ocorrência concluída e lista atualizada a partir do SAU.'
                    : 'Ocorrência concluída no SAU. A lista anterior foi preservada porque a atualização falhou; use Atualizar para tentar novamente.';
                ui.previewBody.prepend(ok);
            }
            mostrarToast(`Ocorrência ${r.numero} concluída no SAU.`);
        } catch (e) {
            console.error('[SAU QOL] Falha ao concluir ocorrência:', e);
            if (envioIniciado) {
                state.conclusoesSemConfirmacao.add(r.numero);
                state.detalhesCache.delete(r.numero);
            }
            if (state.previewNumero === r.numero) {
                const result = ui.previewBody.querySelector('#sau-preview-finish-result');
                const titulo = envioIniciado ? 'Conclusão não confirmada.' : 'Não foi possível enviar a conclusão.';
                const orientacao = envioIniciado ? ' Verifique a ocorrência no SAU antes de tentar novamente.' : '';
                if (result) result.innerHTML = `<div class="sau-preview-blocked"><b>${titulo}</b><br>${escapeHtml(e?.message || String(e))}${orientacao}</div>`;
            }
            if (btn && !envioIniciado) { btn.disabled = false; btn.textContent = 'Concluir ocorrência'; }
        }
    }

    function submeterConclusaoNativa(r, detalhe, solucao) {
        return new Promise((resolve, reject) => {
            const token = `sau-finish-${r.numero}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const iframe = document.createElement('iframe');
            iframe.name = token;
            iframe.dataset.sauLoader = '1';
            iframe.setAttribute('aria-hidden', 'true');
            iframe.style.cssText = 'position:absolute!important;width:1px!important;height:1px!important;left:-10000px!important;top:-10000px!important;border:0!important;visibility:hidden!important;';

            const f = document.createElement('form');
            f.method = 'POST';
            f.action = detalhe.formAction || new URL('/sau/ocorr_detalhes.asp', location.href).href;
            f.target = token;
            f.style.display = 'none';

            const overrides = new Set(['txtSolucao', 'chkConcluir', 'flgIniciar', 'txtStatus']);
            for (const [nome, valor] of detalhe.formFields || []) {
                if (overrides.has(nome)) continue;
                const input = document.createElement('input');
                input.type = 'hidden';
                input.name = nome;
                input.value = valor;
                f.appendChild(input);
            }
            if (detalhe.submitField?.[0]) {
                const submitInput = document.createElement('input');
                submitInput.type = 'hidden';
                submitInput.name = detalhe.submitField[0];
                submitInput.value = String(detalhe.submitField[1] ?? '');
                f.appendChild(submitInput);
            }

            const add = (nome, valor) => {
                const input = document.createElement('input');
                input.type = 'hidden'; input.name = nome; input.value = String(valor ?? '');
                f.appendChild(input);
            };
            add('txtSolucao', solucao);
            add('chkConcluir', '1');
            add('flgIniciar', '2');
            add('txtStatus', '2');

            let terminou = false;
            let timeoutId;
            const cleanup = () => { clearTimeout(timeoutId); f.remove(); iframe.remove(); };
            const falhar = erro => {
                if (terminou) return;
                terminou = true; cleanup(); reject(erro instanceof Error ? erro : new Error(String(erro)));
            };

            iframe.addEventListener('load', () => {
                if (terminou) return;
                try {
                    const href = iframe.contentWindow?.location?.href || '';
                    if (!href || href === 'about:blank') return;
                    const doc = iframe.contentDocument;
                    if (!doc) return falhar(new Error('O SAU não retornou uma página válida após a atualização.'));
                    const statusCode = doc.querySelector('[name="CD_STATUS"]')?.value?.trim() || '';
                    const textoPagina = (doc.body?.textContent || '').replace(/\s+/g, ' ').trim();
                    terminou = true;
                    cleanup();
                    resolve({ statusCode, textoPagina });
                } catch (e) { falhar(e); }
            });

            timeoutId = setTimeout(() => falhar(new Error('Tempo esgotado ao concluir a ocorrência.')), 20000);
            document.body.appendChild(iframe);
            document.body.appendChild(f);
            HTMLFormElement.prototype.submit.call(f);
        });
    }

    async function copiarTexto(valor, msg) {
        const s = String(valor || '');
        try {
            await navigator.clipboard.writeText(s);
        } catch (_) {
            const ta = document.createElement('textarea');
            ta.value = s; ta.style.position = 'fixed'; ta.style.left = '-9999px';
            document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
        }
        mostrarToast(msg || 'Copiado.');
    }

    function mostrarToast(msg) {
        ui.toast.textContent = msg;
        ui.toast.style.display = 'block';
        clearTimeout(mostrarToast._t);
        mostrarToast._t = setTimeout(() => { ui.toast.style.display = 'none'; }, 1400);
    }

    function instalarTooltip() {
        document.addEventListener('mouseover', (ev) => {
            const target = ev.target.closest?.('.sau-resumo[data-tooltip]');
            if (!target) return;
            ui.tooltip.textContent = target.dataset.tooltip || '';
            ui.tooltip.style.display = 'block';
        });
        document.addEventListener('mousemove', (ev) => {
            if (ui.tooltip.style.display !== 'block') return;
            const pad = 14;
            const rect = ui.tooltip.getBoundingClientRect();
            let x = ev.clientX + 12;
            let y = ev.clientY + 14;
            if (x + rect.width > window.innerWidth - pad) x = ev.clientX - rect.width - 12;
            if (y + rect.height > window.innerHeight - pad) y = ev.clientY - rect.height - 12;
            ui.tooltip.style.left = Math.max(pad, x) + 'px';
            ui.tooltip.style.top = Math.max(pad, y) + 'px';
        });
        document.addEventListener('mouseout', (ev) => {
            if (ev.target.closest?.('.sau-resumo[data-tooltip]')) ui.tooltip.style.display = 'none';
        });
    }

    // -------------------------------------------------------------------------
    // Atalhos de teclado
    // -------------------------------------------------------------------------

    function instalarAtalhos() {
        document.addEventListener('keydown', (ev) => {
            const tag = document.activeElement?.tagName;
            const editando = ['INPUT','TEXTAREA','SELECT'].includes(tag) || document.activeElement?.isContentEditable;

            if (ev.key === '/' && !editando) {
                ev.preventDefault(); ui.q.focus(); ui.q.select(); return;
            }

            if (ev.key === 'Escape') {
                if (ui.preview.classList.contains('open')) {
                    fecharPreview();
                } else if (state.pesquisa) {
                    limparPesquisa(true);
                }
                return;
            }

            // Com a prévia aberta, ← e → percorrem as ocorrências. Não interfere
            // quando o usuário está digitando a solução ou usando outro campo.
            if (ui.preview.classList.contains('open') && !editando && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
                ev.preventDefault();
                navegarPreview(ev.key === 'ArrowLeft' ? -1 : 1);
                return;
            }

            if (editando) return;

            if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
                const rows = [...ui.tbody.querySelectorAll('tr[data-numero]')];
                if (!rows.length) return;
                ev.preventDefault();
                const delta = ev.key === 'ArrowDown' ? 1 : -1;
                if (state.selectedIndex < 0) state.selectedIndex = delta > 0 ? 0 : rows.length - 1;
                else state.selectedIndex = Math.max(0, Math.min(rows.length - 1, state.selectedIndex + delta));
                rows.forEach((r, i) => r.classList.toggle('sau-selected', i === state.selectedIndex));
                rows[state.selectedIndex]?.scrollIntoView({ block:'nearest' });
                return;
            }

            if (ev.key === 'Enter' && state.selectedIndex >= 0) {
                const rows = [...ui.tbody.querySelectorAll('tr[data-numero]')];
                const row = rows[state.selectedIndex];
                const reg = row ? state.registrosPorNumero.get(row.dataset.numero) : null;
                if (reg) { ev.preventDefault(); abrirDetalhe(reg); }
            }
        });
    }

    // -------------------------------------------------------------------------
    // Carregamento de todas as paginas do ASP legado
    // -------------------------------------------------------------------------

    async function carregarTodasAsPaginas(paginaJaCarregada = paginacaoInicial.atual) {
        const geracao = ++state.geracaoCarga;
        const total = state.totalPaginasServidor;
        const assinaturaInicial = assinaturaPagina(document);
        state.paginasConfirmadas.add(paginaJaCarregada);

        if (total <= 1) {
            state.carregadoCompleto = true;
            state.carregando = false;
            state.atualizadoEm = Date.now();
            ui.progressWrap.style.display = 'none';
            atualizarSituacoes();
            renderizar();
            salvarCacheCompleto();
            return;
        }

        state.carregando = true;
        state.carregadoCompleto = false;
        state.cacheRestaurado = false;
        state.paginasComErro = [];
        state.historicoInconsistente = false;
        ui.progressWrap.style.display = 'block';
        atualizarProgresso();

        const fila = [];
        for (let p = 1; p <= total; p++) if (!state.paginasConfirmadas.has(p)) fila.push(p);

        for (const pagina of fila) {
            try {
                const doc = await buscarPaginaNativa(pagina, total);
                if (geracao !== state.geracaoCarga) return;
                const info = extrairPaginacao(doc);
                if (info.total !== total) throw new Error(`Total de páginas mudou de ${total} para ${info.total}.`);
                if (extrairRegistros(doc).some(reg => state.registrosPorNumero.has(reg.numero))) {
                    state.historicoInconsistente = true;
                    throw new Error('Ocorrências repetidas entre páginas; o histórico pode ter mudado durante a carga.');
                }
                extrairEAdicionar(doc);
                state.paginasConfirmadas.add(pagina);
            } catch (e) {
                console.warn('[SAU QOL] Falha ao carregar página', pagina, e);
                state.paginasComErro.push(pagina);
            } finally {
                if (geracao === state.geracaoCarga) {
                    state.paginasCarregadas = state.paginasConfirmadas.size;
                    atualizarProgresso();
                    atualizarSituacoes();
                    renderizar();
                }
            }
            await sleep(70);
        }

        if (geracao !== state.geracaoCarga) return;
        if (!state.paginasComErro.length) {
            try {
                const primeiraAtual = await buscarPaginaNativa(paginaJaCarregada, total);
                if (geracao !== state.geracaoCarga) return;
                if (assinaturaPagina(primeiraAtual) !== assinaturaInicial) {
                    state.historicoInconsistente = true;
                }
            } catch (e) {
                state.historicoInconsistente = true;
                console.warn('[SAU QOL] Não foi possível confirmar a estabilidade da primeira página:', e);
            }
        }

        state.carregando = false;
        state.paginasComErro = [...new Set(state.paginasComErro)].sort((a,b) => a-b);
        state.carregadoCompleto = !state.historicoInconsistente && state.paginasComErro.length === 0 && state.paginasConfirmadas.size === total;
        state.atualizadoEm = Date.now();
        atualizarSituacoes();
        atualizarProgresso();
        if (state.carregadoCompleto) {
            salvarCacheCompleto();
            setTimeout(() => { if (!state.carregando) ui.progressWrap.style.display = 'none'; }, 450);
        }
        renderizar();
    }

    function iniciarAtualizacao() {
        if (state.carregando) return Promise.resolve(false);
        if (state.atualizacaoPromise) return state.atualizacaoPromise;
        const promise = recarregarTudo();
        state.atualizacaoPromise = promise;
        const liberar = () => {
            if (state.atualizacaoPromise === promise) state.atualizacaoPromise = null;
        };
        promise.then(liberar, liberar);
        return promise;
    }

    async function recarregarTudo() {
        if (state.carregando || state.atualizando) return false;
        state.atualizando = true;
        state.erroAtualizacao = '';
        state.progressoAtualizacao = { carregadas: 0, total: 1 };
        ui.progressWrap.style.display = 'block';
        renderizar();

        try {
            const primeira = await buscarPaginaNativa(1);
            const infoPrimeira = extrairPaginacao(primeira);
            if (!infoPrimeira.encontrada && state.totalPaginasServidor > 1) {
                throw new Error('A resposta não confirmou a paginação do histórico.');
            }
            const total = infoPrimeira.total;
            const assinaturaInicial = assinaturaPagina(primeira);
            const novos = new Map();
            for (const reg of extrairRegistros(primeira)) novos.set(reg.numero, reg);
            state.progressoAtualizacao = { carregadas: 1, total };
            atualizarProgresso();
            renderizar();

            for (let pagina = 2; pagina <= total; pagina++) {
                const doc = await buscarPaginaNativa(pagina, total);
                const info = extrairPaginacao(doc);
                if (info.total !== total) throw new Error('O total de páginas mudou durante a atualização.');
                const registros = extrairRegistros(doc);
                if (registros.some(reg => novos.has(reg.numero))) {
                    throw new Error('Há ocorrências repetidas entre páginas; o histórico mudou durante a atualização.');
                }
                for (const reg of registros) novos.set(reg.numero, reg);
                state.progressoAtualizacao.carregadas = pagina;
                atualizarProgresso();
                renderizar();
                await sleep(70);
            }

            if (total > 1) {
                const primeiraAtual = await buscarPaginaNativa(1, total);
                if (assinaturaPagina(primeiraAtual) !== assinaturaInicial) {
                    throw new Error('A primeira página mudou durante a atualização.');
                }
            }

            state.registrosPorNumero = novos;
            state.registros = [...novos.values()];
            state.totalPaginasServidor = total;
            state.paginasConfirmadas = new Set(Array.from({ length: total }, (_, i) => i + 1));
            state.paginasCarregadas = total;
            state.paginasComErro = [];
            state.carregadoCompleto = true;
            state.cacheRestaurado = false;
            state.historicoInconsistente = false;
            state.detalhesCache.clear();
            state.atualizadoEm = Date.now();
            salvarCacheCompleto();
            return true;
        } catch (e) {
            console.warn('[SAU QOL] Atualização não concluída:', e);
            state.erroAtualizacao = e?.message || String(e);
            limparCache();
            return false;
        } finally {
            state.atualizando = false;
            state.progressoAtualizacao = null;
            ui.progressWrap.style.display = 'none';
            atualizarSituacoes();
            renderizar();
        }
    }

    function atualizarProgresso() {
        const total = Math.max(1, state.atualizando ? (state.progressoAtualizacao?.total || 1) : state.totalPaginasServidor);
        const confirmadas = state.atualizando ? (state.progressoAtualizacao?.carregadas || 0) : state.paginasConfirmadas.size;
        const pct = Math.max(0, Math.min(100, (confirmadas / total) * 100));
        ui.progress.style.width = pct.toFixed(1) + '%';
    }

    function renderAviso() {
        const avisos = [];
        if (state.erroAtualizacao) avisos.push(`<div class="sau-warn"><b>Atualização não concluída:</b> ${escapeHtml(state.erroAtualizacao)} A lista anterior foi preservada.</div>`);
        if (state.historicoInconsistente) avisos.push('<div class="sau-warn"><b>Histórico possivelmente alterado durante a carga.</b> Atualize para tentar novamente; a pesquisa global pode estar incompleta.</div>');
        if (state.paginasComErro.length) avisos.push(`<div class="sau-warn"><b>Dados incompletos:</b> ${state.paginasConfirmadas.size}/${state.totalPaginasServidor} páginas carregadas. Falharam: ${state.paginasComErro.join(', ')}. Use <b>Atualizar</b> para tentar novamente.</div>`);
        ui.warning.innerHTML = avisos.join('');
    }

    function coletarCamposOriginais(pagina) {
        const campos = camposServidorBase.map(([k, v]) => [k, v]);
        campos.push(['hidCurrentPage', String(pagina)]);
        return campos;
    }

    function buscarPaginaNativa(pagina, totalEsperado = null) {
        return new Promise((resolve, reject) => {
            const token = `sau-loader-${pagina}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const iframe = document.createElement('iframe');
            iframe.name = token;
            iframe.id = token;
            iframe.dataset.sauLoader = '1';
            iframe.setAttribute('aria-hidden', 'true');
            iframe.style.cssText = 'position:absolute!important;width:1px!important;height:1px!important;left:-10000px!important;top:-10000px!important;border:0!important;visibility:hidden!important;';

            const f = document.createElement('form');
            f.method = 'POST';
            f.action = form.action || location.href;
            f.target = token;
            f.style.display = 'none';

            for (const [nome, valor] of coletarCamposOriginais(pagina)) {
                const input = document.createElement('input');
                input.type = 'hidden'; input.name = nome; input.value = valor; f.appendChild(input);
            }

            let terminou = false;
            let timeoutId;
            const cleanup = () => { clearTimeout(timeoutId); f.remove(); iframe.remove(); };
            const falhar = erro => {
                if (terminou) return;
                terminou = true; cleanup(); reject(erro instanceof Error ? erro : new Error(String(erro)));
            };

            iframe.addEventListener('load', () => {
                if (terminou) return;
                try {
                    const href = iframe.contentWindow?.location?.href || '';
                    if (!href || href === 'about:blank') return;
                    const carregado = iframe.contentDocument;
                    if (!carregado || !localizarTabelaResultados(carregado)) {
                        falhar(new Error('Resposta sem tabela de ocorrências; a sessão pode ter expirado.'));
                        return;
                    }
                    const info = extrairPaginacao(carregado);
                    if ((pagina > 1 || totalEsperado > 1) && !info.encontrada) {
                        falhar(new Error('A resposta não confirmou a paginação solicitada.'));
                        return;
                    }
                    if (info.encontrada && info.atual !== pagina) {
                        falhar(new Error(`O SAU retornou página ${info.atual} ao pedir ${pagina}.`));
                        return;
                    }
                    if (totalEsperado !== null && info.total !== totalEsperado) {
                        falhar(new Error(`O total de páginas mudou de ${totalEsperado} para ${info.total}.`));
                        return;
                    }
                    const html = '<!doctype html>\n' + carregado.documentElement.outerHTML;
                    const doc = new DOMParser().parseFromString(html, 'text/html');
                    terminou = true; cleanup(); resolve(doc);
                } catch (e) { falhar(e); }
            });

            timeoutId = setTimeout(() => falhar(new Error(`Tempo esgotado na página ${pagina}.`)), 20000);
            document.body.appendChild(iframe);
            document.body.appendChild(f);
            HTMLFormElement.prototype.submit.call(f);
        });
    }

    // -------------------------------------------------------------------------
    // Escape / debounce / sleep
    // -------------------------------------------------------------------------

    function escapeHtml(v) {
        return String(v ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    function escapeAttr(v) {
        return escapeHtml(v).replace(/`/g, '&#096;');
    }

    function debounce(fn, ms) {
        let t;
        return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    }

    function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
})();
