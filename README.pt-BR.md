[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português (Brasil)](README.pt-BR.md)

# Plugin Grok para Claude Code e Codex

Execute o Grok Build a partir do Claude Code ou do Codex para revisões de código, auditorias de repositório, buscas no X, tarefas delegadas e geração de imagens. Este projeto é um fork de [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc); consulte [NOTICE](NOTICE).

## Requisitos e instalação

Instale o [Grok Build](https://x.ai/cli), faça login ou configure a respectiva chave de API e instale o Git 2.45 ou posterior (ou uma versão do Git com `--no-lazy-fetch` portado). No Windows, macOS e Linux, instale o Bun 1.4.4 ou posterior ou o Node.js 22 ou posterior; quando ambos estiverem disponíveis, o Bun é o preferido. O uso do Grok é cobrado na conta ou na chave de API utilizada. O Grok precisa oferecer suporte a `grok agent stdio`; se necessário, atualize-o com `grok update`.

No Windows, o plugin inclui auxiliares nativos para os runtimes ia32, x64 e arm64. Não é necessário instalar Rust nem MSVC.

No Claude Code:

```text
/plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
/plugin install grok@kagayoi-grok
```

Para o Codex, execute:

```bash
codex plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
codex plugin add grok@kagayoi-grok
```

Inicie uma nova tarefa no Codex para carregar as skills. Se usar os dois hosts, instale separadamente em cada um.

### Atualizações

O Claude Code mantém a atualização automática desativada por padrão para marketplaces de terceiros, como `kagayoi-grok`. Para ativá-la, execute `/plugin` em uma sessão do Claude Code, abra a aba **Marketplaces**, selecione `kagayoi-grok` e escolha **Enable auto-update**. Depois disso, o Claude Code atualiza o marketplace após o início de uma sessão e atualiza o plugin instalado; execute `/reload-plugins` ou inicie uma nova sessão para carregar a nova versão. Para atualizar imediatamente, execute `claude plugin update grok@kagayoi-grok` no seu shell.

Para o Codex, execute `codex plugin marketplace upgrade kagayoi-grok` para atualizar o marketplace e, em seguida, inicie uma nova tarefa no Codex.

## Comandos

O Claude Code expõe `/grok:review`, `/grok:adversarial-review`, `/grok:audit`, `/grok:imagine`, `/grok:rescue`, `/grok:x` e `/grok:setup`. No Codex, selecione a skill `grok:source-command-<name>` correspondente. A revisão e a auditoria são somente leitura; o rescue pode solicitar edições, enquanto a busca no X permanece somente leitura. `/grok:imagine <description>` pede ao Grok Build que gere uma imagem e a copia para `grok-imagine/` no workspace, ou para `--output <path>` quando esse caminho permanece dentro do workspace. Ele não edita o restante do repositório. Com `grok login`, a geração usa o saldo semanal compartilhado da assinatura. Se `XAI_API_KEY` estiver definido, o comando para até que `--allow-api-billing` seja passado: imagens da API são cobradas pelas tarifas da xAI (`grok-imagine-image-2.0` está listado a partir de $0.04/img), e não por esse saldo. O setup verifica a autenticação do Grok.

No Windows, use `/grok:review --scope working-tree` para revisar alterações locais. Os escopos `auto` e `working-tree` exigem um snapshot completo e seguro do Windows e falham se ele não puder ser coletado. No macOS/Linux, use explicitamente `/grok:review --scope branch` ou `--base <ref>` para revisar alterações já commitadas; as alterações não commitadas ficam fora do diff de comparação, mas os arquivos ao redor ainda podem ser lidos a partir da árvore de trabalho. Use `/grok:audit authentication` para direcionar uma auditoria de todo o repositório a um tema específico em qualquer plataforma, ou `/grok:rescue <task>` para delegar uma tarefa. A revisão, a revisão adversarial e a auditoria também aceitam `--language <BCP 47 tag>`. Execute `/grok:setup` quando a instalação ou a autenticação falhar; siga o erro informado e as orientações de login do Grok.

Cada invocação executa uma nova sessão do Grok em primeiro plano e retorna o resultado diretamente. Use a própria interface do Grok para continuar uma conversa. As revisões automáticas e os antigos comandos de status, result, cancel, state-lock e task-resume não são mais suportados pelo companion.

O companion inicia a CLI do Grok instalada localmente. Ele verifica os caminhos nas requisições de arquivo do ACP e aplica uma lista de permissões somente leitura; tarefas de escrita solicitadas explicitamente podem modificar o workspace. O Grok Build cuida de suas próprias operações internas de sistema de arquivos e de shell, do acesso externo e da autenticação. O companion não intermedeia todas as operações de E/S nem oferece um sandbox do sistema operacional, e não garante isolamento completo de acesso, inclusive por meio de links simbólicos. Revise a saída e as alterações do Grok antes de confiar nelas.

## Idioma de exibição

As mensagens do próprio companion (resultados do setup, títulos de revisão, diagnósticos e ajuda) são exibidas no idioma do seu ambiente. Ele consulta `GROK_PLUGIN_LANGUAGE`, depois `LC_ALL`, `LC_MESSAGES` e `LANG`, em seguida o idioma de exibição do sistema, e recorre ao inglês como padrão. Os idiomas suportados são `ja`, `en`, `zh-CN`, `zh-TW`, `ko`, `es`, `fr`, `de` e `pt-BR`. Isso é independente de `--language`, que define o idioma do texto de revisão do Grok. A saída do próprio Grok e os detalhes de erro do sistema operacional ou do Grok não são traduzidos.

## Solução de problemas

Se uma invocação relatar HTTP 402 com `usage balance exhausted`, o saldo de uso do Grok Build se esgotou. Tente novamente depois que esse saldo for restabelecido. A geração de imagens por assinatura usa esse mesmo saldo compartilhado. Se a geração informar que as ferramentas de imagem do Grok Build precisam de uma assinatura SuperGrok, este login não inclui o Imagine; use um plano que o inclua ou uma chave de API com `--allow-api-billing`. Um timeout, uma negação de permissão, uma revisão incompleta ou uma parada do agente não confirmada configuram uma invocação com falha; não trate uma saída parcial como uma revisão ou tarefa concluída.

Durante revisões somente leitura, wrappers de Python, Node.js, Bun e shell são negados, mesmo para scripts destinados apenas a ler arquivos. O Grok Build pode encerrar o turno com `cancelled` após a rejeição de uma permissão. Use as ferramentas de arquivo integradas para inspecionar JSON e outras evidências; evidências indisponíveis permanecem não verificadas. O prompt de revisão informa essas restrições antes de a inspeção começar.

Para builds a partir do código-fonte, comandos de desenvolvimento e validação, consulte [Desenvolvimento](CONTRIBUTING.md#english). A estrutura e os limites do runtime estão descritos em [DESIGN.md](DESIGN.md).
