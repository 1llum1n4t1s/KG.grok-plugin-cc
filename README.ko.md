[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português (Brasil)](README.pt-BR.md)

# Claude Code 및 Codex용 Grok 플러그인

Claude Code 또는 Codex에서 Grok Build를 실행하여 코드 리뷰, 저장소 감사, X 검색, 위임 작업, 이미지 생성을 수행합니다. 이 프로젝트는 [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)의 포크이며, 자세한 내용은 [NOTICE](NOTICE)를 참조하십시오.

## 요구 사항 및 설치

[Grok Build](https://x.ai/cli)를 설치하고 로그인하거나 API 키를 설정한 다음, Git 2.45 이상(또는 `--no-lazy-fetch`가 백포트된 Git 빌드)을 설치합니다. Windows, macOS, Linux에서는 Bun 1.4.4 이상 또는 Node.js 22 이상을 설치합니다. 둘 다 있는 경우 Bun을 우선 사용합니다. Grok 사용 요금은 사용한 계정 또는 API 키에 청구됩니다. Grok은 `grok agent stdio`를 지원해야 하며, 필요한 경우 `grok update`로 업데이트하십시오.

Windows에서는 플러그인에 ia32, x64, arm64 런타임용 네이티브 헬퍼가 포함되어 있습니다. Rust나 MSVC를 설치할 필요가 없습니다.

Claude Code에서는 다음을 실행합니다.

```text
/plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
/plugin install grok@kagayoi-grok
```

Codex에서는 다음을 실행합니다.

```bash
codex plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
codex plugin add grok@kagayoi-grok
```

스킬을 불러오려면 새 Codex 작업을 시작하십시오. 두 호스트를 모두 사용하는 경우 각각 별도로 설치해야 합니다.

### 업데이트

Claude Code는 `kagayoi-grok`과 같은 서드파티 마켓플레이스에 대해 기본적으로 자동 업데이트를 끕니다. 켜려면 Claude Code 세션에서 `/plugin`을 실행하고 **Marketplaces** 탭을 연 다음 `kagayoi-grok`을 선택하여 **Enable auto-update**를 선택하십시오. 그러면 Claude Code가 세션 시작 후 마켓플레이스를 새로 고치고 설치된 플러그인을 업데이트합니다. 새 버전을 불러오려면 `/reload-plugins`를 실행하거나 새 세션을 시작하십시오. 즉시 업데이트하려면 셸에서 `claude plugin update grok@kagayoi-grok`을 실행하십시오.

Codex에서는 `codex plugin marketplace upgrade kagayoi-grok`을 실행하여 마켓플레이스를 새로 고친 다음 새 Codex 작업을 시작하십시오.

## 명령어

Claude Code에서는 `/grok:review`, `/grok:adversarial-review`, `/grok:audit`, `/grok:imagine`, `/grok:rescue`, `/grok:x`, `/grok:setup`을 사용할 수 있습니다. Codex에서는 대응하는 `grok:source-command-<name>` 스킬을 선택하십시오. 리뷰와 감사는 읽기 전용이고, rescue는 편집을 요청할 수 있으며, X 검색은 읽기 전용입니다. `/grok:imagine <description>`은 Grok Build에 이미지를 생성하게 하고, 워크스페이스의 `grok-imagine/` 또는 워크스페이스 안에 있는 `--output <path>`로 복사합니다. 저장소의 다른 파일은 편집하지 않습니다. `grok login`에서는 생성이 구독의 공유 주간 사용량 풀에서 차감됩니다. `XAI_API_KEY`가 있으면 `--allow-api-billing`을 붙일 때까지 명령이 멈춥니다. API 이미지는 그 풀이 아니라 xAI 요금으로 청구됩니다(`grok-imagine-image-2.0`은 $0.04/img부터). Setup은 Grok 인증을 확인합니다.

Windows에서는 `/grok:review --scope working-tree`로 로컬 변경 사항을 리뷰합니다. `auto` 및 `working-tree` 범위는 안전한 Windows 스냅샷 전체가 필요하며, 수집할 수 없으면 실패합니다. macOS/Linux에서는 커밋된 변경 사항을 리뷰하려면 `/grok:review --scope branch` 또는 `--base <ref>`를 명시적으로 사용하십시오. 커밋되지 않은 변경 사항은 비교 diff에서 제외되지만, 주변 파일은 작업 트리에서 읽을 수 있습니다. 어느 플랫폼에서나 `/grok:audit authentication`으로 저장소 전체 감사의 초점을 지정할 수 있고, `/grok:rescue <task>`로 작업을 위임할 수 있습니다. 리뷰, 적대적 리뷰, 감사는 `--language <BCP 47 tag>`도 지원합니다. 설치나 인증에 실패하면 `/grok:setup`을 실행하고, 보고된 오류와 Grok의 로그인 안내를 따르십시오.

각 호출은 새로운 Grok 세션을 포그라운드에서 실행하고 결과를 직접 반환합니다. 대화를 이어가려면 Grok 자체 인터페이스를 사용하십시오. 자동 리뷰와 이전의 status, result, cancel, state-lock, task-resume 명령은 더 이상 컴패니언에서 지원되지 않습니다.

컴패니언은 로컬에 설치된 Grok CLI를 시작합니다. ACP 파일 요청의 경로를 확인하고 읽기 전용 권한 허용 목록을 적용하지만, 명시적으로 요청된 쓰기 작업은 워크스페이스를 수정할 수 있습니다. 내장 파일 시스템 및 셸 작업, 외부 접근, 인증은 Grok Build가 처리합니다. 컴패니언은 모든 I/O 작업을 중재하거나 OS 샌드박스를 제공하지 않으며, 심볼릭 링크를 통한 경우를 포함하여 접근 격리를 완전하게 보장하지 않습니다. Grok의 출력과 변경 사항은 신뢰하기 전에 검토하십시오.

## 표시 언어

컴패니언 자체의 메시지(설정 결과, 리뷰 제목, 진단, 도움말)는 사용 환경의 언어로 표시됩니다. `GROK_PLUGIN_LANGUAGE`를 먼저 확인하고, 이어서 `LC_ALL`, `LC_MESSAGES`, `LANG`, 그다음 시스템 표시 언어를 확인하며, 해당하는 것이 없으면 영어로 대체합니다. 지원 언어는 `ja`, `en`, `zh-CN`, `zh-TW`, `ko`, `es`, `fr`, `de`, `pt-BR`입니다. 이는 Grok의 리뷰 텍스트 언어를 지정하는 `--language`와는 별개입니다. Grok 자체의 출력과 OS 또는 Grok이 제공하는 오류 상세 내용은 번역되지 않습니다.

## 문제 해결

호출 시 `usage balance exhausted`와 함께 HTTP 402가 보고되면 Grok Build의 사용 잔액이 소진된 것입니다. 잔액이 회복된 후 다시 시도하십시오. 구독 로그인의 이미지 생성도 같은 공유 풀을 사용합니다. 이미지 도구에 SuperGrok 구독이 필요하다고 보고되면 이 로그인에는 Imagine이 포함되지 않은 것입니다. Imagine이 포함된 플랜을 쓰거나, `--allow-api-billing`을 붙인 API 키를 사용하십시오. 타임아웃, 권한 거부, 불완전한 리뷰, 확인되지 않은 에이전트 중지는 실패한 호출입니다. 부분적인 출력을 완료된 리뷰나 작업으로 간주하지 마십시오.

`/grok:imagine`의 이미지 모델을 고르려면 `--image-model <id>`를 전달하거나 `GROK_PLUGIN_IMAGE_MODEL`을 설정하세요. 기존 이미지를 편집할 때는 `--image-edit-model <id>`(또는 `GROK_PLUGIN_IMAGE_EDIT_MODEL`)를 사용하며, 생성용 ID를 편집에 재사용하지 않습니다. companion은 해당 실행 동안에만 Grok의 `GROK_IMAGE_GEN_MODEL_OVERRIDE` / `GROK_IMAGE_EDIT_MODEL_OVERRIDE`를 설정하고, 요청한 ID를 `--json`의 `requestedImageModel`로 보고합니다. 이 옵션이 없으면 기본값은 `grok-imagine-image-2.0`(최고 품질이며 편집에도 사용)입니다. 다만 사용자가 `GROK_IMAGE_GEN_MODEL_OVERRIDE` / `GROK_IMAGE_EDIT_MODEL_OVERRIDE`를 직접 설정했다면 그 값을 그대로 Grok에 전달합니다. 옵션이나 `GROK_PLUGIN_IMAGE_*`에 `auto`(대소문자 구분 없음)를 지정하면 Grok이 선택합니다. 이 경우 플러그인은 아무것도 설정하지 않고, 사용자가 직접 설정한 override가 있으면 그대로 전달하며, 없으면 `requestedImageModel`은 `null`입니다. ID는 문자만 검사하며, 계정에서 쓸 수 없는 ID는 이미지 생성 시 xAI가 거부합니다. `--effort`는 채팅 모델의 추론 깊이이며 이미지 품질이 아닙니다.

읽기 전용 리뷰와 읽기 전용 작업(`--write` 없는 `task`) 중에는 파일을 읽기 위한 용도의 스크립트라 하더라도 Python, Node.js, Bun, 셸 래퍼가 거부됩니다. Grok Build는 권한이 거부된 후 `cancelled`로 턴을 종료할 수 있습니다. JSON 및 기타 증거를 확인하려면 내장 파일 도구를 사용하십시오. 확인할 수 없는 증거는 미검증 상태로 남습니다. 리뷰 프롬프트와 읽기 전용 작업에서 요청 뒤에 덧붙이는 안내가 검사가 시작되기 전에 이러한 제한 사항을 제공합니다.

소스 빌드, 개발 명령, 검증에 대해서는 [개발](CONTRIBUTING.md#english)을 참조하십시오. 런타임 구조와 경계는 [DESIGN.md](DESIGN.md)에 설명되어 있습니다.
