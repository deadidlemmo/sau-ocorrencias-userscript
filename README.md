# S.A.U. — Minhas Ocorrências

![Tampermonkey](https://img.shields.io/badge/Userscript-Tampermonkey-161b22?style=for-the-badge&logo=tampermonkey&logoColor=9cdd64) ![Versão](https://img.shields.io/badge/versão-1.0.1-6e9f43?style=for-the-badge)

Melhorias de interface para a tela **Minhas Ocorrências** do S.A.U., desenvolvidas por **Nilson Cruz** como userscript independente. O script usa os formulários e as respostas do sistema original; não altera seu backend.

## Recursos

- Pesquisa instantânea, filtros por situação e período e contadores.
- Carregamento do histórico em várias páginas para pesquisa e ordenação no navegador.
- Paginação própria e tabela mais compacta.
- Prévia e navegação entre ocorrências.
- Ações rápidas, inclusive conclusão quando a conta já possui a permissão necessária.
- Cache local de preferências e da lista carregada para agilizar a navegação.

## Instalação

1. Instale Tampermonkey em um navegador autorizado para acessar o S.A.U.
2. Abra [o userscript 1.0.1](SAU-Minhas-Ocorrencias-Melhorias-v1.0.1.user.js), copie o conteúdo e crie um novo script no painel do Tampermonkey.
3. Salve e abra a tela **Minhas Ocorrências** com sua própria conta.

O endereço da página atendida está declarado em `@match` no cabeçalho do script. O complemento não concede permissões nem armazena a senha do usuário.

## Situação e limites

A versão 1.0.1 está **pronta para validação no ambiente interno**; a conclusão rápida ainda precisa de teste real controlado antes de ampliar o uso. Se o carregamento do histórico falhar, o script informa a incompletude em vez de apresentar a lista parcial como completa. O S.A.U. continua sendo a fonte oficial dos dados.

O código público remove o número funcional e o telefone pessoal do rodapé. Relate problemas em [GitHub Issues](https://github.com/deadidlemmo/sau-ocorrencias-userscript/issues) sem publicar chamados, dados pessoais ou credenciais.

## Arquivos

| Arquivo | Conteúdo |
| --- | --- |
| [`SAU-Minhas-Ocorrencias-Melhorias-v1.0.1.user.js`](SAU-Minhas-Ocorrencias-Melhorias-v1.0.1.user.js) | Versão atual do userscript |

## Autoria

Projeto independente de **Nilson Cruz**. A autoria se refere às melhorias do navegador, e não ao sistema S.A.U. Não há licença de reutilização definida neste repositório.
