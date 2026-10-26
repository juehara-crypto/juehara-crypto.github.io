---
title: '「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第18回：定期実行でドリフトを自動検知する'
description: '定期実行でドリフトを検知する仕組みを、GitOpsのパイプラインの上に作る。mainのコードで比べると未適用の差分がドリフトとして報告されることを確かめ、環境ごとに最後に適用したコミットのコードで実環境と比べる。結果を「差分なし」「差分あり」「検知失敗」の3つに分け、検知と適用のstateのロックの衝突、self-hostedランナーの停止で検知が止まったことに気づく仕組み、検知結果の残し方、複数環境での検知を扱う。Ansible×Terraformシリーズ第37回の定期検知を、稼働し続ける環境に向けて深掘りする回。'
pubDate: 2026-10-22
category: 'infra'
tags: ['Ansible', 'Terraform', 'GitOps', 'ドリフト', 'GitHub Actions']
seriesId: 'ansible-gitops-part4'
seriesNo: 18
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/'
relatedSeries: ''
---

<style> table th, table td { word-break: normal; } table td:first-child { white-space: nowrap; } </style>


> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第4部まとめブログ：ドリフトの区別・検知・収束・例外・予防を「最後に適用したコミット」でつなぐ** **※近日公開予定**

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [mainと比べると未適用の差分を誤報する](#2-mainと比べると未適用の差分を誤報する)
3. [検知結果を3つに分ける](#3-検知結果を3つに分ける)
4. [検知と適用の衝突](#4-検知と適用の衝突)
5. [検知が止まったことに気づく](#5-検知が止まったことに気づく)
6. [検知結果をどこに残すか](#6-検知結果をどこに残すか)
7. [複数環境での検知](#7-複数環境での検知)
8. [クラウドでも同じ設計で検知できる](#8-クラウドでも同じ設計で検知できる)
9. [まとめ](#9-まとめ)
10. [次回予告](#10-次回予告)
11. [連載一覧：「Ansible×TerraformをGitOpsで回す」](#11-連載一覧ansibleterraformをgitopsで回す)

---

## 1. はじめに

TerraformとAnsibleのパイプラインに、ドリフトを見つけるための定期実行を加えていて、

* スケジュール実行で、`terraform plan`と`ansible-playbook --check`を定期的に回している
* 差分が出たという知らせは、一度も来ていない
* よって、ドリフトは起きていない

と考えていないでしょうか。

定期実行によるドリフトの検知を扱う記事の多くは、スケジュールを設定して`plan`や`--check`を回し、差分が出たら知らせるところまでを扱っています。検知の結果が誤っていたとき、検知そのものが失敗したとき、検知が止まっていたときに、それをどう見分けるかは、あまり扱われていません。承認ゲートや昇格の順序を持つパイプラインに定期検知を加えると、次のような場面にぶつかります。

* 承認を待っているだけの変更が、検知のたびにドリフトとして報告され、誰も報告を見なくなった
* 操作対象に接続できずに失敗していた検知が、「差分なし」として数えられていた
* 定期検知の`plan`がstateのロックを取っていて、同じ時刻に起動した適用が止まった
* ランナーが止まっていて、検知が何日も実行されていなかったのに、誰も気づかなかった

これらは、通知の設定や、スケジュールの組み方の問題に見えます。共通しているのは、検知が何と何を比べているのか、その結果をどの状態として扱うのか、そして検知そのものが動いていることをどこで確かめるのかが、決まっていない点です。

`--check`で検知できる範囲は、**[「Ansibleは冪等なのに、なぜサーバは壊れていくのか」](https://qiita.com/juehara-crypto/items/2a375a2c0fca3a8df0ca)**（以下、ドリフトシリーズ）で扱ってきました。

|回|扱った内容|
|---|---|
|**[ドリフトシリーズ第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-02/)**|`--check`が検知できるのは、Playbookに記述されている範囲の差分だけで、`--check`で問題が出なかったことは、ドリフトがないことの証明にはならないことを確かめた|
|**[ドリフトシリーズ第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-04/)**|ドリフトへの対処を、防ぐ・検知する・修正するの3つの設計に整理し、検知する設計として、Playbookや`--check`の定期実行と、その限界を示した|

定期実行による検知そのものは、「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」（以下、Ansible×Terraformシリーズ）でも扱いました。

|回|扱った内容|
|---|---|
|**[Ansible×Terraformシリーズ第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)**|GitHub Actionsのスケジュール実行で`ansible-playbook --check`を流し、出力の`changed=`の数を集計して、差分があったときにだけ本実行するワークフロー「Drift Check」を作った。集計は、最初は`PLAY RECAP`の最後の1行だけを読んでいて、ほかのホストの差分を見落とすため、すべてのホストの値を合算する形に直した。実行のたびに使い捨てられるホステッドランナーで、コンテナの起動から改ざんの注入、検知までを、1回のワークフローの実行の中で完結させる構成だった|

本シリーズでは、これまでの回で、次の整理と仕組みを積み上げてきました。

|部|回|扱った内容|
|---|---|---|
|第1部|**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)**|ホステッドランナーからは、プライベートなネットワークの中にある操作対象に届かないことを確かめ、操作対象と同じネットワークに置くself-hostedランナーを採用した。self-hostedランナーなら、実行をまたいで同じ操作対象を観測でき、その間に加えた手動変更も見えることを確かめた|
|第2部|**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)**|tfstateをpgバックエンドに移し、手元の`terraform apply`がロックを持っている間は、パイプラインの`terraform plan`が`Error acquiring the state lock`で止まることを確かめた|
|第2部|**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)**|dev、stg、prodの順にしか適用できない昇格の仕組みを作り、環境ごとに「最後に適用したコミット」を記録した|
|第2部|**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)**|self-hostedランナーが止まっていると、ジョブは失敗にならず、待機のまま進まないことを確かめた|
|第3部|**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)**|Terraformが作っていた接続用の鍵と、Terraformの変数で渡していたユーザーのパスワードを、tfstateに残らない形に移した。**[Ansible×Terraformシリーズ第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** から引き継いでいた「Drift Check」と、同じくホステッドランナーで環境を一から作る「E2E Provisioning Test」は、tfstateから書き出す鍵と、Terraformの変数で渡すパスワードを前提にしていたため動かなくなり、無効にした|
|第4部|**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)**|「main」「最後に適用したコミット」「実環境」の3つの状態を区別し、mainのコードで実行した確認モードの差分には、未適用の差分とドリフトが混ざることを確かめた。今のパイプラインは変更のときにしか動かず、「Drift Check」も動き続けている環境を見ていないことを整理した|

**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)** では、ドリフトだけを見るには、mainではなく、環境ごとに最後に適用したコミットのコードで、実環境と比べる必要があると整理しました。また、**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** で示した「唯一の真実」が崩れる経路のうち、収束処理が走らない期間の放置は、第2部・第3部の仕組みを入れても残っていました。今のパイプラインには、変更がない間に、動き続けている環境を観測する仕組みがありません。

第18回となる今回は、**[ドリフトシリーズ第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-04/)** の「検知する」を、GitOpsのパイプラインの上に作ります。まず、mainのコードで定期検知を実行すると、承認や昇格を待っている変更がドリフトとして報告されることを確かめ、最後に適用したコミットのコードで比べる形にします。次に、検知の結果を「差分なし」「差分あり」「検知失敗」の3つに分け、失敗した検知を「差分なし」と取り違えないようにします。そのうえで、検知の`plan`と適用の間で起きるstateのロックの衝突と、その避け方を確かめます。続けて、self-hostedランナーが止まって検知が動かなくなったことに、別の場所から気づく仕組みを作り、検知の結果を同じドリフトのたびに増やさずに残す方法と、3つの環境での検知を確かめます。最後に、この設計がクラウドのプロバイダーでも変わらないことを示します。**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)** で無効にしたままの「Drift Check」と「E2E Provisioning Test」は、どちらもホステッドランナーの中で環境を一から作るもので、動き続けている環境は見ていません。この回で作る定期検知との関係を踏まえて、2つの扱いもこの回で決めます。検知したドリフトを自動で直すかどうかは、**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** で扱います。

正確に言うと、**差分が出たという知らせが来ないことは、ドリフトがないことの証明にはなりません。比べる相手を誤らず、検知の失敗を差分なしと取り違えず、検知が止まったことにも気づけて、初めて検知と言えます**。この回で扱う問いは、「定期検知を、誤報せず、見逃さず、止まったことにも気づける仕組みにするには、何が必要なのか」です。

次のセクションでは、mainのコードで定期検知を実行したときに、何が報告されるかを確認します。

---

[↑ 目次に戻る](#-目次)

---

## 2. mainと比べると未適用の差分を誤報する

定期検知で、mainのコードと実環境を比べると何が報告されるかを確かめ、環境ごとに最後に適用したコミットのコードで比べる検知を作ります。

### 比べるのは、実行したコードと実環境

**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)** のセクション5で整理したとおり、Terraformの`plan`もAnsibleの`--check`も、比べているのは、実行したコードと実環境です。どのコードで実行するかによって、結果に何が入るかが変わります。

|実行するコード|結果に入るもの|
|---|---|
|mainの先頭|未適用の差分（承認や昇格を待っている変更）と、ドリフトの両方|
|環境ごとに最後に適用したコミット|ドリフトだけ|

ワークフローでリポジトリを取り出す`actions/checkout`は、起動したブランチのコミットを取り出します。mainから起動する定期検知でそのまま`plan`と`--check`を実行すれば、比べるのはmainの先頭のコードです。承認ゲートと昇格の順序を持つパイプラインでは、mainにマージしてから、すべての環境に適用し終えるまでの間、未適用の差分が必ずあります。その間、mainのコードで比べる検知は、承認を待っているだけの変更を、毎回「差分あり」として報告することになります。

そこで、検知は、環境ごとに最後に適用したコミットを`gitops.applied`から読み、そのコミットのコードを取り出して実行する形にします。

### ■ 検証内容：検知のワークフローを作る

検知のワークフロー「Drift Detect」を作ります。このセクションでは手動の起動だけにし、比べるコードを、環境ごとに最後に適用したコミット（`last-applied`）と、mainの先頭（`main`）から選べるようにします。2つを同じワークフローで比べるためです。

あわせて、**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)** で無効にしたままの「Drift Check」と「E2E Provisioning Test」のファイルを削除します。

* 「Drift Check」は、ホステッドランナーの中で環境を一から作って検知するもので、動き続けている環境を見ていない。動き続けている環境を見る検知は、「Drift Detect」に置き換える
* 「E2E Provisioning Test」は、環境を一から作ってTestinfraで確かめ、鍵の作り直しによるコンテナの作り直しを検出するものだった。作り直しの検出は、**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** のplanの判定が、承認ゲートの入口で担っている
* どちらも、**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)** で外した、tfstateから書き出す秘密鍵と、Terraformの変数で渡すパスワードを前提にしていて、そのままでは動かない

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops18-drift-detect
cat > .github/workflows/drift-detect.yml <<'EOF'
（ファイルの内容。下のcat -nの結果と同じ）
EOF
git rm -q .github/workflows/drift-check.yml .github/workflows/e2e-provisioning-test.yml
cat -n .github/workflows/drift-detect.yml
python3 -c 'import yaml; yaml.safe_load(open(".github/workflows/drift-detect.yml")); print("yaml ok")'
git status --short
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops18-drift-detect'
     1  name: Drift Detect
     2
     3  on:
     4    workflow_dispatch:
     5      inputs:
     6        compare_with:
     7          description: '実環境と比べるコード（last-applied：環境ごとに最後に適用したコミット、main：mainの先頭のコミット）'
     8          type: choice
     9          options:
    10            - last-applied
    11            - main
    12          default: last-applied
    13
    14  permissions:
    15    contents: read
    16
    17  jobs:
    18    detect:
    19      runs-on: [self-hosted, Linux, X64]
    20      steps:
    21        - name: Check branch
    22          run: |
    23            echo "ref=$GITHUB_REF sha=$GITHUB_SHA"
    24            if [ "$GITHUB_REF" != "refs/heads/main" ]; then
    25              echo "::error::not started from main"
    26              exit 1
    27            fi
    28        - uses: actions/checkout@v4
    29          with:
    30            fetch-depth: 0
    31        - name: Add Ansible to PATH
    32          run: echo "$HOME/ansible-env/bin" >> "$GITHUB_PATH"
    33        - name: Write private keys from secrets
    34          env:
    35            CONNECT_PRIVATE_KEY_DEV: ${{ secrets.CONNECT_PRIVATE_KEY_DEV }}
    36            CONNECT_PRIVATE_KEY_STG: ${{ secrets.CONNECT_PRIVATE_KEY_STG }}
    37            CONNECT_PRIVATE_KEY_PROD: ${{ secrets.CONNECT_PRIVATE_KEY_PROD }}
    38          run: |
    39            umask 077
    40            mkdir -p "$RUNNER_TEMP/keys/dev" "$RUNNER_TEMP/keys/stg" "$RUNNER_TEMP/keys/prod"
    41            printf '%s\n' "$CONNECT_PRIVATE_KEY_DEV" > "$RUNNER_TEMP/keys/dev/id_ed25519"
    42            printf '%s\n' "$CONNECT_PRIVATE_KEY_STG" > "$RUNNER_TEMP/keys/stg/id_ed25519"
    43            printf '%s\n' "$CONNECT_PRIVATE_KEY_PROD" > "$RUNNER_TEMP/keys/prod/id_ed25519"
    44            ls -l "$RUNNER_TEMP/keys/dev" "$RUNNER_TEMP/keys/stg" "$RUNNER_TEMP/keys/prod"
    45        - name: Detect drift
    46          env:
    47            COMPARE_WITH: ${{ inputs.compare_with }}
    48            PG_CONN_STR: ${{ secrets.PG_CONN_STR }}
    49            TF_VAR_deploy_user_password: ${{ secrets.TF_VAR_DEPLOY_USER_PASSWORD }}
    50            ANSIBLE_VAULT_PASSWORD_GITOPS16: ${{ secrets.ANSIBLE_VAULT_PASSWORD_GITOPS16 }}
    51            GITOPS_KEY_DIR: ${{ runner.temp }}/keys
    52          run: |
    53            for e in dev stg prod; do
    54              echo "== $e"
    55              if [ "$COMPARE_WITH" = "main" ]; then
    56                ref="$GITHUB_SHA"
    57              else
    58                ref=$(.github/scripts/applied.sh last "$e")
    59              fi
    60              echo "compare_with=$COMPARE_WITH ref=$ref"
    61              wt="$RUNNER_TEMP/detect-$e"
    62              git worktree add --detach "$wt" "$ref" > /dev/null
    63              terraform -chdir="$wt/terraform/envs/$e" init -input=false -lockfile=readonly > /dev/null
    64              rc=0
    65              terraform -chdir="$wt/terraform/envs/$e" plan -input=false -no-color -detailed-exitcode || rc=$?
    66              echo "$e plan_exit_code=$rc"
    67              rc=0
    68              (cd "$wt/ansible" && ansible-playbook -i "inventories/$e" site.yml --check --diff --vault-id "gitops16@$GITHUB_WORKSPACE/.github/scripts/vault-pass-client.sh") || rc=$?
    69              echo "$e check_exit_code=$rc"
    70              git worktree remove --force "$wt"
    71            done
    72        - name: Clean up
    73          if: always()
    74          run: |
    75            rm -rf "$RUNNER_TEMP/keys"
    76            git worktree prune
yaml ok
D  .github/workflows/drift-check.yml
D  .github/workflows/e2e-provisioning-test.yml
?? .github/workflows/drift-detect.yml
```

ワークフローの中身は、次のとおりです。

* 3〜12行目：手動の起動だけで、比べるコードを`last-applied`（既定）と`main`から選ぶ
* 19行目：操作対象に届く、self-hostedランナーで動かす（**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)**）
* 21〜27行目：main以外から起動されたら止める
* 33〜44行目：3環境の接続用の秘密鍵を、Secretsから一時ディレクトリに書き出す。**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)** で決めた、「GitOps Pipeline」の確認モードと同じ渡し方
* 55〜59行目：比べるコミットを決める。`last-applied`なら、`applied.sh`でその環境の最後に適用したコミットを読み、`main`なら、起動したmainのコミットを使う
* 61〜63行目：そのコミットのコードを、一時ディレクトリに取り出し（`git worktree`）、その環境のTerraformを初期化する
* 64〜66行目：取り出したコードで`plan -detailed-exitcode`を実行し、終了コードを表示する
* 67〜69行目：取り出したコードで確認モード（`--check --diff`）を実行し、終了コードを表示する
* 72〜76行目：成功・失敗にかかわらず、秘密鍵と、取り出したコードの記録を片付ける

比べる対象のコード（Terraformの定義、ロール、インベントリのスクリプト）は、取り出した側を使います。一方、最後に適用したコミットを読む`applied.sh`と、Vaultパスワードを渡すスクリプトは、検知の道具として、mainの側（`$GITHUB_WORKSPACE`）を使います。比べる結果の3つの分け方は、**[セクション3](#3-検知結果を3つに分ける)** で加えます。

この変更をコミットしてプッシュし、プルリクエスト（PR#85）を作りました。確認の実行（「GitOps Pipeline」の実行#154）では、変更が`.github/workflows/`の下だけのため、`changes`ジョブが`terraform=false`・`ansible=false`と判定し、ほかのジョブはすべてスキップされました。PR#85をマージしました（マージコミット`7b32327`、「GitOps Pipeline」の実行#155）。承認待ちは作られていません。

### ■ 検証内容：未適用の差分がない状態で検知する

この時点で、mainは`7b32327`、3環境の最後に適用したコミットは、**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)** のセクション5で適用した`0ce29b9`です。2つの間の変更はワークフローのファイルだけで、インフラのコードは同じです。この状態で、「Drift Detect」を`last-applied`で起動しました（「Drift Detect」の実行#1）。

**▼ 実行結果**（「Drift Detect」の実行#1、`detect`ジョブのステップ「Detect drift」から抜粋）

```plaintext
== dev
compare_with=last-applied ref=0ce29b97e0a804f07ae48651294063fb8d71e37e
（途中省略：Refreshing state...によるリソース一覧の出力）
No changes. Your infrastructure matches the configuration.
（途中省略）
dev plan_exit_code=0
（途中省略：PLAYとTASKの表示、Pythonのインタープリターに関する警告）
dev-node1                  : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
dev check_exit_code=0
== stg
（途中省略：devと同じ形の表示）
stg plan_exit_code=0
stg-node1                  : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
stg check_exit_code=0
== prod
（途中省略：devと同じ形の表示）
prod plan_exit_code=0
target-node1               : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
prod check_exit_code=0
```

### ■ 結果

3環境とも、最後に適用したコミット`0ce29b9`のコードを取り出して比べ、`plan`は差分なし（`plan_exit_code=0`）、確認モードは5台とも`changed=0`でした。未適用の差分もドリフトもない状態で、検知は差分なしを報告しています。

### ■ 検証内容：マージ済みで未適用の状態を作る

ここに、インフラを変える変更を1つマージし、承認待ちのまま、どの環境にも適用しない状態を作ります。`plan`と`--check`の両方に差分が出るよう、Ansibleのロールの`/etc/gitops-env.conf`に1行を足し、共通のモジュールに、何も作らない`terraform_data`を1つ足します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops18-pending-detect
sed -i 's/gitops17=pending-check\\n"/gitops17=pending-check\\ngitops18=pending-detect\\n"/' ansible/roles/common_setup/tasks/environment.yml
cat >> terraform/modules/lab_env/main.tf <<'EOF'

resource "terraform_data" "gitops18_pending" {
  input = "gitops18-pending-detect"
}
EOF
git --no-pager diff
set -a; . ~/.config/tfstate-backend/backend.env; set +a
for e in dev stg prod; do echo "== $e"; terraform -chdir=terraform/envs/$e plan -input=false -no-color 2>&1 | grep -E '^  # |^Plan:|No changes|Error'; done
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops18-pending-detect'
diff --git a/ansible/roles/common_setup/tasks/environment.yml b/ansible/roles/common_setup/tasks/environment.yml
index 019e4e2..28d0644 100644
--- a/ansible/roles/common_setup/tasks/environment.yml
+++ b/ansible/roles/common_setup/tasks/environment.yml
@@ -3,5 +3,5 @@
   become: true
   ansible.builtin.copy:
     dest: /etc/gitops-env.conf
-    content: "env={{ common_setup_env }}\npromotion=dev-stg-prod\ngitops17=pending-check\n"
+    content: "env={{ common_setup_env }}\npromotion=dev-stg-prod\ngitops17=pending-check\ngitops18=pending-detect\n"
     mode: "0644"
diff --git a/terraform/modules/lab_env/main.tf b/terraform/modules/lab_env/main.tf
index d1ba5fa..0873567 100644
--- a/terraform/modules/lab_env/main.tf
+++ b/terraform/modules/lab_env/main.tf
@@ -50,3 +50,7 @@ resource "docker_container" "targets" {
     ignore_changes = [network_mode]
   }
 }
+
+resource "terraform_data" "gitops18_pending" {
+  input = "gitops18-pending-detect"
+}
== dev
  # module.lab_env.terraform_data.gitops18_pending will be created
Plan: 1 to add, 0 to change, 0 to destroy.
== stg
  # module.lab_env.terraform_data.gitops18_pending will be created
Plan: 1 to add, 0 to change, 0 to destroy.
== prod
  # module.lab_env.terraform_data.gitops18_pending will be created
Plan: 1 to add, 0 to change, 0 to destroy.
```

この変更をコミットしてプッシュし、プルリクエスト（PR#86）を作りました。確認の実行（「GitOps Pipeline」の実行#156）では、`record-pending`以外のジョブがすべて成功しました。PR#86をマージしました（マージコミット`2edd63f`、「GitOps Pipeline」の実行#157）。

**▼ 実行結果**（「GitOps Pipeline」の実行#157、`changes`ジョブから抜粋）

```plaintext
（途中省略：実行したスクリプト、シェルの表示）
  EVENT_NAME: push
  BASE_SHA: 7b323277b57ba34323bcade11439ad0f547f2f80
  HEAD_SHA: 2edd63fd1580c3832e6faebf25915365dd8f7fcb
（途中省略）
last applied (dev): 0ce29b97e0a804f07ae48651294063fb8d71e37e
last applied (stg): 0ce29b97e0a804f07ae48651294063fb8d71e37e
last applied (prod): 0ce29b97e0a804f07ae48651294063fb8d71e37e
ansible/roles/common_setup/tasks/environment.yml
.github/workflows/drift-check.yml
.github/workflows/drift-detect.yml
.github/workflows/e2e-provisioning-test.yml
terraform/modules/lab_env/main.tf
terraform=true
ansible=true
```

**▼ 実行結果**（「GitOps Pipeline」の実行#157、`record-pending`ジョブから抜粋）

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
== dev
（途中省略：ファイルの一覧）
88c3af1f37fc0f3c215af26633ffa95f22fa69a06a7a27a02b21c45d75c98293  /home/control/gitops-pending/dev/tfplan
commit=2edd63fd1580c3832e6faebf25915365dd8f7fcb
terraform=true
ansible=true
== stg
（途中省略：devと同じ形の表示）
== prod
（途中省略：devと同じ形の表示）
```

3環境の最後に適用したコミット（`0ce29b9`）を基準に変更が判定され、3環境の承認待ちが、マージコミット`2edd63f`で作られました。基準が最後に適用したコミットのため、PR#85のワークフローの変更も、変更の一覧に入っています（**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** のセクション5）。この承認待ちは、適用せずに残します。

これで、mainは`2edd63f`、3環境の最後に適用したコミットは`0ce29b9`のままで、その間に、インフラを変えるコードが入った状態になりました。

### ■ 検証内容：2つのコードで検知する

この状態で、「Drift Detect」を、`last-applied`（「Drift Detect」の実行#2）、`main`（「Drift Detect」の実行#3）の順に起動しました。2つの実行の間に、実環境には何も手を加えていません。

**▼ 実行結果**（「Drift Detect」の実行#2、`detect`ジョブのステップ「Detect drift」から抜粋）

```plaintext
== dev
compare_with=last-applied ref=0ce29b97e0a804f07ae48651294063fb8d71e37e
（途中省略：Refreshing state...によるリソース一覧の出力）
No changes. Your infrastructure matches the configuration.
（途中省略）
dev plan_exit_code=0
（途中省略：PLAYとTASKの表示、Pythonのインタープリターに関する警告）
dev-node1                  : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
dev check_exit_code=0
== stg
（途中省略：devと同じ形の表示）
stg plan_exit_code=0
stg-node1                  : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
stg check_exit_code=0
== prod
（途中省略：devと同じ形の表示）
prod plan_exit_code=0
target-node1               : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
prod check_exit_code=0
```

**▼ 実行結果**（「Drift Detect」の実行#3、`detect`ジョブのステップ「Detect drift」から抜粋）

```plaintext
== dev
compare_with=main ref=2edd63fd1580c3832e6faebf25915365dd8f7fcb
（途中省略：Refreshing state...によるリソース一覧の出力）
  # module.lab_env.terraform_data.gitops18_pending will be created
  + resource "terraform_data" "gitops18_pending" {
      + id     = (known after apply)
      + input  = "gitops18-pending-detect"
      + output = (known after apply)
    }

Plan: 1 to add, 0 to change, 0 to destroy.
（途中省略：-outオプションに関する注意書き）
dev plan_exit_code=2
（途中省略：PLAYとTASKの表示、Pythonのインタープリターに関する警告）
TASK [common_setup : 環境の名前を書いたファイルを配置] *************************
--- before: /etc/gitops-env.conf
+++ after: /etc/gitops-env.conf
@@ -1,3 +1,4 @@
 env=dev
 promotion=dev-stg-prod
 gitops17=pending-check
+gitops18=pending-detect

changed: [dev-node1]
（途中省略）
dev-node1                  : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
dev check_exit_code=0
== stg
（途中省略：devと同じ形の表示）
stg plan_exit_code=2
stg-node1                  : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
stg check_exit_code=0
== prod
（途中省略：devと同じ形の表示。差分は3台ともenv=prodの後に+gitops18=pending-detect）
prod plan_exit_code=2
target-node1               : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
prod check_exit_code=0
```

### ■ 結果

3回の検知を並べると、次のとおりです。

|実行|未適用の差分|比べたコード|`plan`|確認モード|
|---|---|---|---|---|
|「Drift Detect」の実行#1|なし|最後に適用したコミット`0ce29b9`|3環境とも差分なし（`plan_exit_code=0`）|5台とも`changed=0`|
|「Drift Detect」の実行#2|あり|最後に適用したコミット`0ce29b9`|3環境とも差分なし（`plan_exit_code=0`）|5台とも`changed=0`|
|「Drift Detect」の実行#3|あり|mainの`2edd63f`|3環境とも`terraform_data`の作成（`plan_exit_code=2`）|5台とも`+gitops18=pending-detect`で`changed=1`|

実行#2と実行#3は、同じ時点の同じ実環境を比べています。違うのは、比べたコードだけです。mainのコードで比べると、3環境ともTerraformとAnsibleの両方で差分が報告され、最後に適用したコミットのコードで比べると、差分は報告されませんでした。実環境は、最後に適用したコミットの状態のまま変わっていないため、実行#3の差分は、すべて承認を待っている未適用の差分です。

mainのコードで比べる定期検知は、この差分を、承認と昇格が終わるまで、実行のたびに報告します。**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** の昇格の順序では、devに適用した後も、stgとprodには前のコミットが残ります。その間、stgとprodの差分は報告され続けます。報告の中には、本当のドリフトと、承認を待っているだけの変更が、同じ「差分あり」の形で並ぶことになります。最後に適用したコミットのコードで比べれば、未適用の差分は報告に入らず、残る差分は、記録の後に実環境が変わったもの、つまりドリフトだけになります。

### ■ 検証内容：未適用の差分を解消する

最後に、残しておいた承認待ちを、「GitOps Apply」でdev（「GitOps Apply」の実行#93）、stg（実行#94）、prod（実行#95）の順に適用しました。どの実行も、`verify`、`terraform-apply`、`ansible-apply`、`record-applied`が成功しています。手元で、終了時点の状態を確かめます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
ls -la ~/gitops-pending
set -a; . ~/.config/tfstate-backend/backend.env; set +a
psql "$PG_CONN_STR" -X -c 'SELECT id, env, commit_sha FROM gitops.applied ORDER BY id DESC LIMIT 3;'
for e in dev stg prod; do terraform -chdir=terraform/envs/$e plan -input=false -detailed-exitcode > /dev/null 2>&1; echo "$e plan_exit_code=$?"; done
for n in dev-node1 stg-node1 target-node1 target-node2 target-node3; do echo "== $n"; docker exec $n cat /etc/gitops-env.conf; done
```

**▼ 実行結果**

```plaintext
total 8
drwx------  2 control control 4096 Oct 24 11:42 .
drwxr-x--- 14 control control 4096 Oct 24 11:18 ..
 id | env  |                commit_sha
----+------+------------------------------------------
 61 | prod | 2edd63fd1580c3832e6faebf25915365dd8f7fcb
 60 | stg  | 2edd63fd1580c3832e6faebf25915365dd8f7fcb
 59 | dev  | 2edd63fd1580c3832e6faebf25915365dd8f7fcb
(3 rows)

dev plan_exit_code=0
stg plan_exit_code=0
prod plan_exit_code=0
== dev-node1
env=dev
promotion=dev-stg-prod
gitops17=pending-check
gitops18=pending-detect
（途中省略：stg-node1、target-node1〜3も同じ4行。envの値はstg、prod）
```

### ■ 結果

承認待ちは空になり、3環境とも、最後に適用したコミットが`2edd63f`になりました。3環境とも`plan`は差分なしで、5台の`/etc/gitops-env.conf`には`gitops18=pending-detect`の行が入っています。未適用の差分は、承認と昇格で解消しました。

定期検知が比べる相手は、mainではなく、環境ごとに最後に適用したコミットにする必要があります。ただし、比べる相手を正しくしても、検知の結果が正しく読めるとは限りません。次のセクションでは、検知の結果を「差分なし」「差分あり」「検知失敗」の3つに分けます。

---

[↑ 目次に戻る](#-目次)

---

## 3. 検知結果を3つに分ける

検知の結果を「差分なし」「差分あり」「検知失敗」の3つに分け、失敗した検知を「差分なし」と取り違えない形にします。

### 「差分が出なかった」には2つの意味がある

定期検知の結果が「差分なし」と読めるとき、そこには2つの場合が混ざる可能性があります。比べた結果として本当に差分がなかった場合と、比べること自体ができなかった場合です。操作対象に接続できない、tfstateが読めない、Vaultパスワードが渡っていないといった理由で検知が途中で失敗しても、集計の仕方によっては、差分の数は0として残ります。

TerraformとAnsibleは、どちらも結果を終了コードで返します。

|ツール|終了コード|意味|
|---|---|---|
|`terraform plan -detailed-exitcode`|0|成功し、差分なし|
|`terraform plan -detailed-exitcode`|1|エラー|
|`terraform plan -detailed-exitcode`|2|成功し、差分あり|
|`ansible-playbook --check`|0|すべてのホストで成功（差分の有無は問わない）|
|`ansible-playbook --check`|0以外|失敗したホストがある（**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** のセクション3では、接続できないホストで4、タスクの失敗で2）|

Terraformは、終了コードだけで3つを区別できます。Ansibleは、終了コードで成功と失敗は分かりますが、確認モードで差分があっても終了コードは0のままです（**[セクション2](#2-mainと比べると未適用の差分を誤報する)** の「Drift Detect」の実行#3でも、`changed=1`で`check_exit_code=0`でした）。差分の有無は、終了コードとは別に、実行結果から読み取る必要があります。

### ■ 検証内容：文字列の集計は、検知失敗を差分なしと区別できない

**[Ansible×Terraformシリーズ第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** の「Drift Check」は、確認モードの出力を`tee`でファイルに残し、`PLAY RECAP`の`changed=`の値をすべてのホスト分合算していました。この集計を、prodのtarget-node2を止めた状態で、手元で再現します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible
docker stop target-node2
ansible-playbook -i inventories/prod site.yml --check --vault-id gitops16@$HOME/.config/ansible-vault/gitops16-vault-pass 2>/dev/null | tee /tmp/gitops18-check_result.txt; echo "pipeline_exit_code=$? ansible_exit_code=${PIPESTATUS[0]}"
CHANGED=$(grep -oP 'changed=\K[0-9]+' /tmp/gitops18-check_result.txt | paste -sd+ -); CHANGED=$((CHANGED)); echo "CHANGED=$CHANGED"
```

**▼ 実行結果**

```plaintext
target-node2

PLAY [接続確認用Playbook] ******************************************************

TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] *******************
ok: [target-node3]
ok: [target-node1]
fatal: [target-node2]: UNREACHABLE! => {"changed": false, "msg": "Failed to connect to the host via ssh: ssh: connect to host 172.19.0.4 port 22: Connection timed out", "unreachable": true}
（途中省略：残りのタスクは、target-node1とtarget-node3だけがok）

PLAY RECAP *********************************************************************
target-node1               : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=0    changed=0    unreachable=1    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0

pipeline_exit_code=0 ansible_exit_code=4
CHANGED=0
```

### ■ 結果

`ansible-playbook`は、target-node2に接続できずに終了コード4で失敗しています。ところが、`tee`につないだパイプ全体の終了コードは、最後のコマンドである`tee`の0でした。GitHub Actionsのステップは、シェルを指定しなければ`bash -e`で動きます（本シリーズのジョブのログにも`shell: /usr/bin/bash -e {0}`と表示されます）。`pipefail`が付いていないため、この形のステップは失敗になりません。

集計も、接続できなかったtarget-node2を`changed=0`として数え、合計は0になりました。すべてのホストで差分がなかったときと同じ値です。この集計からは、「差分なし」と「検知失敗」を区別できません。

### ■ 検証内容：確認モードの結果を、機械的に読める形式で取り出す

確認モードの結果を、画面向けの文字列ではなく、JSONで取り出します。ansible-coreには、結果をJSONで出すコールバックが含まれていないため、`ansible.posix`のコレクションに含まれる`ansible.posix.json`を使います。

**実行コマンド**

```plaintext
ansible-doc -t callback -l 2>/dev/null
ansible-galaxy collection install git+https://github.com/ansible-collections/ansible.posix.git,2.2.2
ansible-galaxy collection list ansible.posix
ansible-doc -t callback -l 2>/dev/null | grep -i json
```

**▼ 実行結果**

```plaintext
ansible.builtin.default default Ansible screen output
ansible.builtin.junit   write playbook output to a JUnit file
ansible.builtin.minimal minimal Ansible screen output
ansible.builtin.oneline oneline Ansible screen output
ansible.builtin.tree    Save host events to files
（途中省略：GitHubからの取得の表示）
Installing 'ansible.posix:2.2.2' to '/home/control/.ansible/collections/ansible_collections/ansible/posix'
Created collection for ansible.posix:2.2.2 at /home/control/.ansible/collections/ansible_collections/ansible/posix
ansible.posix:2.2.2 was installed successfully

# /home/control/.ansible/collections/ansible_collections
Collection    Version
------------- -------
ansible.posix 2.2.2
ansible.posix.json              Ansible screen output as JSON
ansible.posix.jsonl             Ansible screen output as JSONL (lines in js...
```

検証の時点では、配布元（Ansible Galaxy）からの取得が`HTTP Error 500`で2回失敗したため、同じバージョンを、コレクションのGitHubのリポジトリから入れています。コレクションは、ランナーと同じユーザーのホームの下に入りました。ワークフローにもリポジトリにも書かれないホスト側の前提が1つ増えたことになります（**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** のセクション4）。

このコールバックで、すべて動いている状態と、target-node2を止めた状態の結果を比べます。JSONの`stats`に、ホストごとの集計が入ります。

**実行コマンド**

```plaintext
VP="gitops16@$HOME/.config/ansible-vault/gitops16-vault-pass"
echo "== all running"
ANSIBLE_STDOUT_CALLBACK=ansible.posix.json ansible-playbook -i inventories/prod site.yml --check --vault-id "$VP" > /tmp/gitops18-check.json 2>/dev/null; echo "ansible_exit_code=$?"
jq -c '.stats' /tmp/gitops18-check.json
docker stop target-node2
echo "== target-node2 stopped"
ANSIBLE_STDOUT_CALLBACK=ansible.posix.json ansible-playbook -i inventories/prod site.yml --check --vault-id "$VP" > /tmp/gitops18-check.json 2>/dev/null; echo "ansible_exit_code=$?"
jq -c '.stats' /tmp/gitops18-check.json
docker start target-node2
```

**▼ 実行結果**

```plaintext
== all running
ansible_exit_code=0
{"target-node1":{"changed":0,"failures":0,"ignored":0,"ok":6,"rescued":0,"skipped":0,"unreachable":0},"target-node2":{"changed":0,"failures":0,"ignored":0,"ok":6,"rescued":0,"skipped":0,"unreachable":0},"target-node3":{"changed":0,"failures":0,"ignored":0,"ok":6,"rescued":0,"skipped":0,"unreachable":0}}
target-node2
== target-node2 stopped
ansible_exit_code=4
{"target-node1":{"changed":0,"failures":0,"ignored":0,"ok":6,"rescued":0,"skipped":0,"unreachable":0},"target-node2":{"changed":0,"failures":0,"ignored":0,"ok":0,"rescued":0,"skipped":0,"unreachable":1},"target-node3":{"changed":0,"failures":0,"ignored":0,"ok":6,"rescued":0,"skipped":0,"unreachable":0}}
target-node2
```

### ■ 結果

target-node2を止めると、`stats`のtarget-node2だけが`"unreachable":1`になりました。`changed`の値はどちらも0ですが、接続できなかったホストは`unreachable`と`failures`の値で見分けられます。文字列を数える方法と違い、ホストごとに、どの値がいくつだったかを読み取れます。

### ■ 検証内容：「Drift Detect」に、3つに分ける判定を加える

「Drift Detect」の「Detect drift」のステップを、次の形に書き換えました（変更したのは「Detect drift」と「Clean up」の2つのステップです）。

**▼ 実行結果**（書き換えた後の`cat -n .github/workflows/drift-detect.yml`から、45〜92行目を抜粋）

```plaintext
    45        - name: Detect drift
    46          env:
    47            COMPARE_WITH: ${{ inputs.compare_with }}
    48            PG_CONN_STR: ${{ secrets.PG_CONN_STR }}
    49            TF_VAR_deploy_user_password: ${{ secrets.TF_VAR_DEPLOY_USER_PASSWORD }}
    50            ANSIBLE_VAULT_PASSWORD_GITOPS16: ${{ secrets.ANSIBLE_VAULT_PASSWORD_GITOPS16 }}
    51            GITOPS_KEY_DIR: ${{ runner.temp }}/keys
    52          run: |
    53            failed=0
    54            for e in dev stg prod; do
    55              echo "== $e"
    56              plan_rc=-1; check_rc=-1; changed=-1; failed_hosts=-1
    57              wt="$RUNNER_TEMP/detect-$e"
    58              out="$RUNNER_TEMP/check-$e.json"
    59              if [ "$COMPARE_WITH" = "main" ]; then
    60                ref="$GITHUB_SHA"
    61              else
    62                ref=$(.github/scripts/applied.sh last "$e") || ref=""
    63              fi
    64              echo "compare_with=$COMPARE_WITH ref=$ref"
    65              if [ -n "$ref" ] && git worktree add --detach "$wt" "$ref" > /dev/null \
    66                && terraform -chdir="$wt/terraform/envs/$e" init -input=false -lockfile=readonly > /dev/null; then
    67                plan_rc=0
    68                terraform -chdir="$wt/terraform/envs/$e" plan -input=false -no-color -detailed-exitcode || plan_rc=$?
    69                check_rc=0
    70                (cd "$wt/ansible" && ANSIBLE_STDOUT_CALLBACK=ansible.posix.json ansible-playbook -i "inventories/$e" site.yml --check --diff --vault-id "gitops16@$GITHUB_WORKSPACE/.github/scripts/vault-pass-client.sh" > "$out") || check_rc=$?
    71                changed=$(jq '[.stats[].changed] | add // 0' "$out") || changed=-1
    72                failed_hosts=$(jq '[.stats[] | select(.unreachable > 0 or .failures > 0)] | length' "$out") || failed_hosts=-1
    73                jq -c '.stats' "$out" || true
    74                jq -r '.plays[].tasks[] | .task.name as $t | .hosts | to_entries[] | select(.value.changed == true) | "changed: \(.key) \($t)"' "$out" || true
    75              fi
    76              if { [ "$plan_rc" -ne 0 ] && [ "$plan_rc" -ne 2 ]; } || [ "$check_rc" -ne 0 ] || [ "$failed_hosts" -ne 0 ]; then
    77                result=detect_failed
    78                failed=1
    79              elif [ "$plan_rc" -eq 2 ] || [ "$changed" -gt 0 ]; then
    80                result=drift
    81              else
    82                result=no_drift
    83              fi
    84              echo "RESULT $e=$result plan_exit_code=$plan_rc check_exit_code=$check_rc changed=$changed failed_hosts=$failed_hosts"
    85              git worktree remove --force "$wt" 2> /dev/null || true
    86            done
    87            exit $failed
    88        - name: Clean up
    89          if: always()
    90          run: |
    91            rm -rf "$RUNNER_TEMP/keys" "$RUNNER_TEMP"/check-*.json
    92            git worktree prune
```

書き換えた箇所は、次のとおりです。

* 56行目：4つの値を、まだ何も確かめていないことを示す`-1`で始める。途中で失敗して値が入らなければ、判定は検知失敗に倒れる
* 62行目：最後に適用したコミットが読めなくても、ステップを止めずに、比べるコミットを空にする
* 65〜66行目：比べるコミットがあり、コードの取り出しと初期化が成功したときだけ、`plan`と確認モードを実行する
* 70行目：確認モードの結果を、`ansible.posix.json`でファイルに書き出す
* 71〜72行目：JSONの`stats`から、`changed`の合計と、接続できない・失敗したホストの数を取り出す
* 73〜74行目：ホストごとの集計と、`changed`になったタスクの名前を、ログに表示する
* 76〜83行目：3つに分ける判定
* 84行目：環境ごとの結果を、1行で表示する
* 87行目：3環境を終えた後、検知失敗が1つでもあればジョブを失敗にする
* 91行目：書き出したJSONも片付ける

判定の決め方は、次のとおりです。

|結果|条件|
|---|---|
|検知失敗（`detect_failed`）|`plan`の終了コードが0・2以外、確認モードの終了コードが0以外、接続できない・失敗したホストがある、または比べるコードを取り出せなかった|
|差分あり（`drift`）|検知失敗ではなく、`plan`の終了コードが2、または確認モードで`changed`のホストがある|
|差分なし（`no_drift`）|上のどちらでもない|

検知失敗を最初に判定し、残った結果の中で差分の有無を見ます。1つの環境が検知失敗になっても、ほかの環境の検知は続けます（**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** のセクション3では、1つの環境の失敗でループ全体が止まり、残りの環境の確認が実行されませんでした）。差分ありではジョブを失敗にしません。差分ありをどう残すかは、**[セクション6](#6-検知結果をどこに残すか)** で扱います。

`changed`の合計は、ずれている箇所の数ではありません。**[ドリフトシリーズ第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-02/)** のセクション3のとおり、`changed`は変更が必要と判定されたタスクの数で、handlerの分も含みます。判定では、0より大きいかどうかだけを使います。

この変更をプルリクエスト（PR#87）にし、確認の実行（「GitOps Pipeline」の実行#158）で`changes`ジョブだけが動いたことを確かめて、マージしました（マージコミット`9280790`、「GitOps Pipeline」の実行#159）。

### ■ 検証内容：3つの結果が並ぶ状態で検知する

1回の検知で3つの結果が並ぶよう、環境ごとに違う状態を作ります。

* dev：dev-node1を止める
* stg：何もしない
* prod：target-node1の`/etc/drift-check-target.conf`を、パイプラインを通さずに書き換える

**実行コマンド**

```plaintext
docker exec target-node1 cat /etc/drift-check-target.conf
docker exec target-node1 sed -i 's/ansible-drift-check/manual-edit/' /etc/drift-check-target.conf
docker exec target-node1 cat /etc/drift-check-target.conf
docker stop dev-node1
docker ps -a --format 'table {{.Names}}\t{{.Status}}' | grep -E 'NAMES|node'
```

**▼ 実行結果**

```plaintext
monitored_by=ansible-drift-check
monitored_by=manual-edit
dev-node1
NAMES          STATUS
dev-node1      Exited (0) 1 second ago
target-node2   Up 13 minutes
target-node3   Up 13 hours
target-node1   Up 13 hours
stg-node1      Up 13 hours
```

この状態で、「Drift Detect」を`last-applied`で起動しました（「Drift Detect」の実行#4）。

**▼ 実行結果**（「Drift Detect」の実行#4、`detect`ジョブのステップ「Detect drift」から抜粋）

```plaintext
== dev
compare_with=last-applied ref=2edd63fd1580c3832e6faebf25915365dd8f7fcb
（途中省略：Refreshing state...によるリソース一覧の出力）
  # module.lab_env.docker_container.targets["dev-node1"] will be created
  + resource "docker_container" "targets" {
（途中省略：作成するコンテナの属性）
      + must_run                                    = true
      + name                                        = "dev-node1"
（途中省略）
Plan: 1 to add, 0 to change, 0 to destroy.
（途中省略：出力値の変化、-outオプションに関する注意書き）
{"dev-node1":{"changed":0,"failures":0,"ignored":0,"ok":0,"rescued":0,"skipped":0,"unreachable":1}}
RESULT dev=detect_failed plan_exit_code=2 check_exit_code=4 changed=0 failed_hosts=1
== stg
compare_with=last-applied ref=2edd63fd1580c3832e6faebf25915365dd8f7fcb
（途中省略：Refreshing state...によるリソース一覧の出力）
No changes. Your infrastructure matches the configuration.
（途中省略）
{"stg-node1":{"changed":0,"failures":0,"ignored":0,"ok":6,"rescued":0,"skipped":0,"unreachable":0}}
RESULT stg=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
== prod
compare_with=last-applied ref=2edd63fd1580c3832e6faebf25915365dd8f7fcb
（途中省略：Refreshing state...によるリソース一覧の出力）
No changes. Your infrastructure matches the configuration.
（途中省略）
{"target-node1":{"changed":1,"failures":0,"ignored":0,"ok":6,"rescued":0,"skipped":0,"unreachable":0},"target-node2":{"changed":0,"failures":0,"ignored":0,"ok":6,"rescued":0,"skipped":0,"unreachable":0},"target-node3":{"changed":0,"failures":0,"ignored":0,"ok":6,"rescued":0,"skipped":0,"unreachable":0}}
changed: target-node1 common_setup : ドリフト検知の実演用設定ファイルを配置
RESULT prod=drift plan_exit_code=0 check_exit_code=0 changed=1 failed_hosts=0
##[error]Process completed with exit code 1.
```

### ■ 結果

1回の検知で、3つの環境の結果が分かれました。

|環境|作った状態|`plan`|確認モード|結果|
|---|---|---|---|---|
|dev|dev-node1を停止|dev-node1の作成（`plan_exit_code=2`）|`unreachable=1`（`check_exit_code=4`）|検知失敗（`detect_failed`）|
|stg|なし|差分なし（`plan_exit_code=0`）|`changed=0`|差分なし（`no_drift`）|
|prod|target-node1のファイルを書き換え|差分なし（`plan_exit_code=0`）|target-node1が`changed=1`|差分あり（`drift`）|

prodは、どのホストのどのタスクに差分があるかまで表示されています。検知失敗が1つあるため、ジョブは終了コード1で失敗しました。devが検知失敗になった後も、stgとprodの検知は最後まで実行されています。

devでは、同じ原因（コンテナの停止）が、Terraformでは差分（コンテナの作成）として、Ansibleでは接続の失敗として現れました。Terraformの結果だけを見れば「差分あり」ですが、検知失敗を先に判定するため、devの結果は検知失敗になっています。

### ■ 検証内容：検知の`plan`が、止まっていたコンテナを削除した

検証の後、元に戻すためにdev-node1を起動しようとしたところ、コンテナそのものがなくなっていました。

**実行コマンド**

```plaintext
docker start dev-node1
set -a; . ~/.config/tfstate-backend/backend.env; set +a
terraform -chdir=terraform/envs/dev state list | grep dev-node1
docker events --since 2026-10-24T13:00:00 --until "$(date -Iseconds)" --filter type=container --filter container=dev-node1
```

**▼ 実行結果**

```plaintext
Error response from daemon: No such container: dev-node1
failed to start containers: dev-node1
module.lab_env.docker_container.targets["dev-node1"]
2026-10-24T13:08:46.783713771Z container kill 5fc109d36684133ed6af332be38410d97d001699700e35d2d323dd25a7b459e0 (image=sha256:580e369fb41b08cc58beded6d6ab0ee567a68bf62d82c8c87eeb7c1bb2aa88b6, name=dev-node1, org.opencontainers.image.version=22.04, signal=15)
2026-10-24T13:08:47.703306319Z container stop 5fc109d36684133ed6af332be38410d97d001699700e35d2d323dd25a7b459e0 (image=sha256:580e369fb41b08cc58beded6d6ab0ee567a68bf62d82c8c87eeb7c1bb2aa88b6, name=dev-node1, org.opencontainers.image.version=22.04)
2026-10-24T13:08:47.738367157Z container die 5fc109d36684133ed6af332be38410d97d001699700e35d2d323dd25a7b459e0 (execDuration=48091, exitCode=0, image=sha256:580e369fb41b08cc58beded6d6ab0ee567a68bf62d82c8c87eeb7c1bb2aa88b6, name=dev-node1, org.opencontainers.image.version=22.04)
2026-10-24T13:10:45.195231137Z container destroy 5fc109d36684133ed6af332be38410d97d001699700e35d2d323dd25a7b459e0 (image=sha256:580e369fb41b08cc58beded6d6ab0ee567a68bf62d82c8c87eeb7c1bb2aa88b6, name=dev-node1, org.opencontainers.image.version=22.04)
```

### ■ 結果

`docker events`には、`docker stop`による停止（13:08:46〜47）の後に、`container destroy`（13:10:45.195）が記録されていました。「Drift Detect」の実行#4のログと並べると、次の順になります。

|時刻（UTC）|出来事|
|---|---|
|13:10:44.62|devの`plan`が`docker_container.targets["dev-node1"]: Refreshing state...`を表示|
|13:10:45.195|dev-node1の`container destroy`|
|13:10:45.37|devの`plan`が`dev-node1 will be created`を表示|

`destroy`は、devの`plan`がdev-node1の状態を読みに行った直後で、計画が表示される前に起きています。この間に、検知のほかに実行したコマンドやワークフローはありません。tfstateにはdev-node1が残っていて、実体だけがなくなりました。

この検証環境（Terraform `v1.15.7`、`kreuzwerker/docker` `3.0.2`、コンテナに`must_run = true`）では、止まっているコンテナに対して`plan`を実行すると、そのコンテナが削除されました。定期検知は実環境を読むだけで、何も変えないものとして作ってきましたが、この組み合わせでは、その前提が成り立ちません。`plan`が実環境に何をするかは、プロバイダーとリソースの設定によって変わります。定期検知を入れる前に、使っているプロバイダーの`plan`が、止まっている・壊れているリソースに対して何をするかを確かめておく必要があります。

dev-node1は、最後に適用したコミット`2edd63f`と同じコード（mainの`9280790`は、`terraform/`と`ansible/`が`2edd63f`と同じ）で、手元から作り直しました。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git --no-pager diff --stat 2edd63f HEAD -- terraform ansible; echo "diff_exit_code=$?"
mkdir -p -m 700 ~/gitops18-plans
(umask 077; terraform -chdir=terraform/envs/dev plan -input=false -no-color -out="$HOME/gitops18-plans/dev.tfplan") | grep -E '^  # |^Plan:|forces replacement|Error'
terraform -chdir=terraform/envs/dev apply -input=false -no-color "$HOME/gitops18-plans/dev.tfplan" | grep -E 'Creating|Creation complete|Apply complete|Error'
docker inspect -f '{{.Name}} id={{printf "%.12s" .Id}} {{range $k, $v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}}{{end}}' dev-node1
cd ansible
ansible-playbook -i inventories/dev site.yml --vault-id "gitops16@$HOME/.config/ansible-vault/gitops16-vault-pass" 2>/dev/null | grep -E ': ok='
```

**▼ 実行結果**

```plaintext
diff_exit_code=0
  # module.lab_env.docker_container.targets["dev-node1"] will be created
Plan: 1 to add, 0 to change, 0 to destroy.
module.lab_env.docker_container.targets["dev-node1"]: Creating...
module.lab_env.docker_container.targets["dev-node1"]: Creation complete after 4s [id=c19b56ffe13230439585b6cb292c6fae7dcab9331d8c49b8757a718ec304bc18]
Apply complete! Resources: 1 added, 0 changed, 0 destroyed.
/dev-node1 id=c19b56ffe132 ansible-dev-net=172.20.0.2
dev-node1                  : ok=6    changed=3    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

dev-node1のコンテナIDは`5fc109d36684`から`c19b56ffe132`に変わり、IPアドレスは`172.20.0.2`のままです。パイプラインの外での適用ですが、コードは記録と同じ内容のため、`gitops.applied`は変えていません。target-node1のファイルも手で元に戻し、5台の確認モードが`changed=0`になることを確かめました。

### ■ 検証内容：すべての環境が差分なしのときに検知する

元に戻した状態で、「Drift Detect」を`last-applied`で起動しました（「Drift Detect」の実行#5）。

**▼ 実行結果**（「Drift Detect」の実行#5、`detect`ジョブのステップ「Detect drift」から抜粋）

```plaintext
RESULT dev=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
RESULT stg=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
RESULT prod=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
```

### ■ 結果

3環境とも差分なしで、`detect`ジョブは成功しました。

検知の結果は、「差分なし」「差分あり」「検知失敗」の3つに分けて初めて、「差分なし」を「比べた結果、差分がなかった」と読めるようになります。ただし、この検証で分かったとおり、検知の`plan`は実環境を変える場合があり、また`plan`はstateのロックも取ります。次のセクションでは、検知の`plan`と適用が重なったときに何が起きるかを確認します。

---

[↑ 目次に戻る](#-目次)

---

## 4. 検知と適用の衝突

検知の`plan`が取るstateのロックと、適用の衝突を確かめ、検知の側の扱いを決めます。

### 検知の`plan`も、stateのロックを取る

**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** では、tfstateをpgバックエンドに移し、手元の`terraform apply`がロックを持っている間は、パイプラインの`terraform plan`が`Error acquiring the state lock`で止まることを確かめました。`plan`は、既定でstateのロックを取ります。定期検知の`plan`も同じです。検知の`plan`がロックを持っている間は適用が止まり、適用がロックを持っている間は検知が止まります。

ただし、パイプラインの中どうしの衝突は、今の構成では起きません。この検証環境のself-hostedランナーは1台で、ランナーは一度に1つのジョブしか実行しないため、「Drift Detect」と「GitOps Apply」は、同じ時刻に起動してもランナーの空きを待って順に動きます。衝突が起きるのは、ランナーを増やしたときと、パイプラインの外からstateに触れたときです。後者は、**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** の手元からの操作や、**[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-20/)** で扱う緊急対応の手動変更のように、今の構成でも起こります。

検知の側の扱いには、次の3つの考え方があります。

|考え方|内容|トレードオフ|
|---|---|---|
|同じ同時実行のグループに入れる|検知を、適用と同じグループに入れて順に動かす|パイプラインの中どうしは重ならない。パイプラインの外からの操作は防げない。検知の間、適用は待つ|
|検知ではロックを取らない|`plan`に`-lock=false`を付ける|適用を止めない。適用の途中のstateを読み、誤った差分を報告するおそれがある|
|検知の時間帯を分ける|適用を行わない時間帯に、スケジュールを置く|設定は簡単。起動の時刻がずれれば重なり、パイプラインの外からの操作も防げない|

この回では、1つ目を採用し、ロックは取ったまま、`plan`がロックの空きを一定時間待つ形にします。`-lock=false`は採用しません。適用の途中のstateを読むおそれに加えて、**[セクション3](#3-検知結果を3つに分ける)** で確かめたとおり、この検証環境の`plan`は実環境を変える場合があるためです。ロックを取らない`plan`が、適用と同じ時刻に実環境を変えることは避けます。

### ■ 検証内容：パイプラインの外からロックを持たれた状態で検知する

まず、今の「Drift Detect」のまま、パイプラインの外からdevのロックを持った状態で検知を動かします。手元で、何も作らない`terraform_data`を作り直す`apply`を起動し、確認の入力で止めたままにします。止まっている間は、手元のTerraformがdevのロックを持ち続けます。

**実行コマンド**（端末A）

```plaintext
cd ~/iac/docker-lab-ci
set -a; . ~/.config/tfstate-backend/backend.env; set +a
terraform -chdir=terraform/envs/dev apply -replace='module.lab_env.terraform_data.gitops18_pending'
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state...によるリソース一覧の出力）
  # module.lab_env.terraform_data.gitops18_pending will be replaced, as requested
-/+ resource "terraform_data" "gitops18_pending" {
      ~ id     = "fb67d4aa-9f41-33b6-9271-b260eb390485" -> (known after apply)
      ~ output = "gitops18-pending-detect" -> (known after apply)
        # (1 unchanged attribute hidden)
    }

Plan: 1 to add, 0 to change, 1 to destroy.

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value:
```

別の端末から、PostgreSQLのadvisory lockを確かめます。

**実行コマンド**（端末B）

```plaintext
cd ~/iac/docker-lab-ci
set -a; . ~/.config/tfstate-backend/backend.env; set +a
psql "$PG_CONN_STR" -X -c "SELECT locktype, classid, objid, granted FROM pg_locks WHERE locktype = 'advisory';"
```

**▼ 実行結果**

```plaintext
 locktype | classid | objid | granted
----------+---------+-------+---------
 advisory |       0 |    24 | t
(1 row)
```

この状態で、「Drift Detect」を`last-applied`で起動しました（「Drift Detect」の実行#6）。

**▼ 実行結果**（「Drift Detect」の実行#6、`detect`ジョブのステップ「Detect drift」から抜粋）

```plaintext
== dev
compare_with=last-applied ref=2edd63fd1580c3832e6faebf25915365dd8f7fcb

Error: Error acquiring the state lock

Error message: Workspace is already locked: default
Lock Info:
  ID:        7d7504ee-b8ea-1745-80b7-2cf2ad130310
  Path:      
  Operation: OperationTypePlan
  Who:       control@ubuntu-controller
  Version:   1.15.7
  Created:   2026-10-25 05:39:07.342472944 +0000 UTC
  Info:      

（途中省略：-lock=falseに関する注意書き）
{"dev-node1":{"changed":0,"failures":0,"ignored":0,"ok":6,"rescued":0,"skipped":0,"unreachable":0}}
RESULT dev=detect_failed plan_exit_code=1 check_exit_code=0 changed=0 failed_hosts=0
== stg
（途中省略）
RESULT stg=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
== prod
（途中省略）
RESULT prod=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
##[error]Process completed with exit code 1.
```

実行#6が終わった後、端末Aで`no`と入力して取り消し、ロックが残っていないこと、`terraform_data`が作り直されていないことを確かめました。

**▼ 実行結果**（端末A、`no`を入力した後）

```plaintext
  Enter a value: no

Apply cancelled.
```

**▼ 実行結果**（端末B）

```plaintext
 locktype | classid | objid | granted
----------+---------+-------+---------
(0 rows)

dev plan_exit_code=0
    id     = "fb67d4aa-9f41-33b6-9271-b260eb390485"
```

### ■ 結果

devの`plan`は、ロックを取れずに`Error acquiring the state lock`で失敗し、終了コードは1でした。確認モードは成功していますが、判定は検知失敗（`detect_failed`）で、ジョブも失敗しています。ロックが取れなかった検知は、「差分なし」として扱われていません。**[セクション3](#3-検知結果を3つに分ける)** の判定がなければ、devはAnsibleの結果だけを見て「差分なし」と読めてしまう状態でした。

`Lock Info`の`Operation`は`OperationTypePlan`で、`Created`はエラーの直前の時刻です。**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** と同じく、表示されているのは、ロックを持っている側（手元の`apply`）ではなく、取ろうとした側（検知の`plan`）の情報です。

### ■ 検証内容：同時実行のグループに入れ、ロックの空きを待つ

「Drift Detect」を次のように変えました。

* 「GitOps Pipeline」「GitOps Apply」と同じ同時実行のグループ（`gitops-pipeline`）に入れる。待機中の実行が、後から来た実行で取り消されないよう、`queue: max`もそろえる（**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)**）
* `plan`に`-lock-timeout=5m`を付け、ロックが取られていても5分までは空くのを待つ。5分を過ぎたら、これまでどおり検知失敗になる

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops18-detect-lock
sed -i 's/^permissions:$/concurrency:\n  group: gitops-pipeline\n  queue: max\n\npermissions:/' .github/workflows/drift-detect.yml
sed -i 's/plan -input=false -no-color -detailed-exitcode || plan_rc/plan -input=false -no-color -detailed-exitcode -lock-timeout=5m || plan_rc/' .github/workflows/drift-detect.yml
git --no-pager diff
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops18-detect-lock'
diff --git a/.github/workflows/drift-detect.yml b/.github/workflows/drift-detect.yml
index 8415246..fc54e49 100644
--- a/.github/workflows/drift-detect.yml
+++ b/.github/workflows/drift-detect.yml
@@ -11,6 +11,10 @@ on:
           - main
         default: last-applied

+concurrency:
+  group: gitops-pipeline
+  queue: max
+
 permissions:
   contents: read

@@ -65,7 +69,7 @@ jobs:
             if [ -n "$ref" ] && git worktree add --detach "$wt" "$ref" > /dev/null \
               && terraform -chdir="$wt/terraform/envs/$e" init -input=false -lockfile=readonly > /dev/null; then
               plan_rc=0
-              terraform -chdir="$wt/terraform/envs/$e" plan -input=false -no-color -detailed-exitcode || plan_rc=$?
+              terraform -chdir="$wt/terraform/envs/$e" plan -input=false -no-color -detailed-exitcode -lock-timeout=5m || plan_rc=$?
               check_rc=0
               (cd "$wt/ansible" && ANSIBLE_STDOUT_CALLBACK=ansible.posix.json ansible-playbook -i "inventories/$e" site.yml --check --diff --vault-id "gitops16@$GITHUB_WORKSPACE/.github/scripts/vault-pass-client.sh" > "$out") || check_rc=$?
               changed=$(jq '[.stats[].changed] | add // 0' "$out") || changed=-1
```

この変更をプルリクエスト（PR#88）にし、確認の実行（「GitOps Pipeline」の実行#160）で`changes`ジョブだけが動いたことを確かめて、マージしました（マージコミット`97262dd`、「GitOps Pipeline」の実行#161）。

そのうえで、もう一度、端末Aで同じ`apply`を確認の入力で止め、devのロックを持った状態で「Drift Detect」を起動しました（「Drift Detect」の実行#7）。devの`plan`がロックを待ち始めてから1分ほど後（日本時間の15:00）に、端末Aで`no`と入力して取り消しています。

**▼ 実行結果**（「Drift Detect」の実行#7、`detect`ジョブのステップ「Detect drift」から抜粋。時刻はUTC）

```plaintext
05:58:31.0947809Z == dev
05:58:31.1914597Z compare_with=last-applied ref=2edd63fd1580c3832e6faebf25915365dd8f7fcb
05:58:34.6813964Z Acquiring state lock. This may take a few moments...
06:00:25.9045534Z module.lab_env.terraform_data.gitops18_pending: Refreshing state... [id=fb67d4aa-9f41-33b6-9271-b260eb390485]
（途中省略：Refreshing state...によるリソース一覧の出力）
06:00:28.2733300Z No changes. Your infrastructure matches the configuration.
（途中省略）
06:00:34.8664791Z RESULT dev=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
06:00:34.8723856Z == stg
（途中省略）
06:00:47.9163003Z RESULT stg=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
06:00:47.9232049Z == prod
（途中省略）
06:01:04.0809455Z RESULT prod=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
```

実行#7の後、ロックが残っていないこと、`terraform_data`の`id`が`fb67d4aa-...`のままであることを、端末Bで確かめました。

### ■ 結果

devの`plan`は、`Acquiring state lock.`と表示した後、約1分51秒待ち、手元の`apply`を取り消した直後に状態の読み込みを始めました。`Error acquiring the state lock`は出ず、devは差分なしと判定され、ジョブは成功しています。

この形で、検知と適用の関係は次のようになります。

|衝突の相手|今の扱い|
|---|---|
|パイプラインの中の適用（「GitOps Pipeline」「GitOps Apply」）|同じグループで順に動くため、ランナーを増やしても重ならない|
|パイプラインの外からの短い操作|5分までは、ロックが空くのを待ってから比べる|
|パイプラインの外からの長い操作|5分を過ぎると検知失敗になり、「差分なし」とは扱わない|

待つ時間には上限を置いています。同じグループに入れたため、検知が待っている間は、後から起動した適用も待つことになるからです。上限を長くするほど、検知が適用を止める時間も長くなります。

ここまでで、検知は比べる相手を誤らず、失敗を差分なしと取り違えず、適用とも重ならない形になりました。ただし、これは検知が動いている間の話です。次のセクションでは、検知そのものが動かなくなったときに、何が起きるかを確認します。

---

[↑ 目次に戻る](#-目次)

---

## 5. 検知が止まったことに気づく

定期検知そのものが動かなくなったときに、それを別の場所から確かめる仕組みを作ります。

### 検知は、失敗せずに止まる

ここまでの検知は、動いている間の結果を正しく分ける仕組みでした。検知そのものが動かなければ、結果は1件も出ません。「差分あり」も「検知失敗」も来ない状態は、何も起きていない状態と同じに見えます。

検知が止まる経路は、2つあります。

|経路|起きること|
|---|---|
|self-hostedランナーが止まる|**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** のセクション4のとおり、ジョブは失敗にならず、ランナーを待ったまま進まない。公式ドキュメントでは、待ち行列に24時間入ったジョブは自動で取り消される|
|スケジュール実行そのものが動かない|公式ドキュメントでは、`schedule`はGitHub Actionsの実行が多い時間帯に遅れることがあり、負荷が十分に高いと、待っているジョブが落とされることもある。公開リポジトリでは、60日間動きがないとスケジュール実行が自動で無効になる|

どちらの場合も、検知のワークフローの中では何も起きないため、検知のワークフロー自身は自分が止まったことを報告できません。止まったことに気づくには、検知とは別の場所から、検知が最後に成功した時刻を確かめる必要があります。

この確かめ方は、操作対象に届く必要がありません。読むのは、GitHubに残っている検知の実行の一覧だけです。**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** で確かめたとおり、ホステッドランナーはプライベートなネットワークの中の操作対象には届きませんが、GitHubのAPIには届きます。そこで、この確かめ方はホステッドランナーで動かします。self-hostedランナーとは別の場所で動くため、self-hostedランナーが止まっていても影響を受けません。

### ■ 検証内容：スケジュール実行と、確認用のワークフローを加える

「Drift Detect」にスケジュール実行を加え、あわせて、確認用のワークフロー「Drift Detect Watch」を作りました。検証の間だけ、「Drift Detect」は15分ごと、「Drift Detect Watch」はその5分後に動く設定にしています（公式ドキュメントで混む時間帯とされている毎時0分は避けました）。スケジュールで起動した実行には手動の起動の入力がないため、比べるコードの入力が空なら`last-applied`を使うようにも直しています。

**▼ 実行結果**（`git diff`、「Drift Detect」の変更）

```plaintext
@@ -1,6 +1,8 @@
 name: Drift Detect

 on:
+  schedule:
+    - cron: '5-59/15 * * * *'
   workflow_dispatch:
     inputs:
       compare_with:
@@ -48,7 +50,7 @@ jobs:
           ls -l "$RUNNER_TEMP/keys/dev" "$RUNNER_TEMP/keys/stg" "$RUNNER_TEMP/keys/prod"
       - name: Detect drift
         env:
-          COMPARE_WITH: ${{ inputs.compare_with }}
+          COMPARE_WITH: ${{ inputs.compare_with || 'last-applied' }}
           PG_CONN_STR: ${{ secrets.PG_CONN_STR }}
```

**▼ 実行結果**（`cat -n .github/workflows/drift-detect-watch.yml`）

```plaintext
     1  name: Drift Detect Watch
     2
     3  on:
     4    schedule:
     5      - cron: '10-59/15 * * * *'
     6    workflow_dispatch:
     7
     8  permissions:
     9    actions: read
    10    contents: read
    11
    12  jobs:
    13    watch:
    14      runs-on: ubuntu-latest
    15      steps:
    16        - name: Check last successful Drift Detect
    17          env:
    18            GH_TOKEN: ${{ github.token }}
    19            MAX_AGE_MINUTES: 40
    20          run: |
    21            set -euo pipefail
    22            runs=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/drift-detect.yml/runs?per_page=20")
    23            echo "$runs" | jq -r '.workflow_runs[] | "#\(.run_number) \(.event) \(.status) \(.conclusion) created=\(.created_at) updated=\(.updated_at)"'
    24            last=$(echo "$runs" | jq -r '[.workflow_runs[] | select(.conclusion == "success")] | first | .updated_at // empty')
    25            waiting=$(echo "$runs" | jq '[.workflow_runs[] | select(.status == "queued" or .status == "waiting" or .status == "pending")] | length')
    26            echo "last_success=$last waiting_runs=$waiting"
    27            if [ -z "$last" ]; then
    28              echo "::error::no successful Drift Detect run found"
    29              exit 1
    30            fi
    31            age=$(( ( $(date -u +%s) - $(date -u -d "$last" +%s) ) / 60 ))
    32            echo "age_minutes=$age max_age_minutes=$MAX_AGE_MINUTES"
    33            if [ "$age" -gt "$MAX_AGE_MINUTES" ]; then
    34              echo "::error::last successful Drift Detect finished $age minutes ago"
    35              exit 1
    36            fi
```

「Drift Detect Watch」の中身は、次のとおりです。

* 8〜10行目：GitHubのAPIで実行の一覧を読むための`actions: read`と、`contents: read`だけを渡す
* 14行目：ホステッドランナーで動かす
* 22〜23行目：「Drift Detect」の直近20件の実行を読み、番号、きっかけ（`schedule`か`workflow_dispatch`か）、状態、結果、時刻を表示する
* 24〜26行目：最後に成功した実行の終了時刻と、待っている実行の数を出す
* 27〜36行目：成功した実行がない、または最後の成功が決めた時間（ここでは40分。15分ごとの検知を2回取りこぼした頃）より古ければ、失敗にする

この変更をプルリクエスト（PR#89）にし、確認の実行（「GitOps Pipeline」の実行#162）で`changes`ジョブだけが動いたことを確かめて、マージしました（マージコミット`d7ade2a`、「GitOps Pipeline」の実行#163、日本時間15:25頃）。

### ■ 結果：15分ごとのスケジュール実行が、約4時間動かなかった

マージの後、スケジュール実行を待ちましたが、約4時間、「Drift Detect」と「Drift Detect Watch」のどちらにも、スケジュールの実行は出ませんでした。原因を切り分けるため、次の2つを試しています。

|日本時間|行ったこと|スケジュールの実行|
|---|---|---|
|15:25頃|PR#89をマージ（15分ごとのスケジュールを加える）|出ない|
|16:28頃|cronの書き方を、範囲と間隔（`5-59/15`）から、公式ドキュメントの例と同じ時刻の並べ方（`5,20,35,50 * * * *`）に直した（PR#90、「GitOps Pipeline」の実行#164・#165、マージコミット`a482950`）|出ない|
|17:20頃|2つのワークフローを、いったん無効にしてから有効に戻した|出ない|
|19:25頃|（ここまで、約4時間）|出ない|

この間に、「Drift Detect Watch」を手動で起動しています（「Drift Detect Watch」の実行#1、日本時間16:22）。

**▼ 実行結果**（「Drift Detect Watch」の実行#1、`watch`ジョブから抜粋）

```plaintext
#7 workflow_dispatch completed success created=2026-10-25T05:58:21Z updated=2026-10-25T06:01:11Z
#6 workflow_dispatch completed failure created=2026-10-25T05:38:52Z updated=2026-10-25T05:39:51Z
（途中省略：#5〜#1も、すべてworkflow_dispatch）
last_success=2026-10-25T06:01:11Z waiting_runs=0
age_minutes=81 max_age_minutes=40
##[error]last successful Drift Detect finished 81 minutes ago
##[error]Process completed with exit code 1.
```

「Drift Detect」の実行は、すべて手動の起動（`workflow_dispatch`）で、スケジュール（`schedule`）で動いた実行は1件もありません。最後の成功は81分前で、確認役はそれを報告して失敗しました。

スケジュールを置いたのに、約4時間、検知は1回も動かず、その間、どの画面にも失敗は表示されませんでした。GitHubからはこの間の原因は公表されていないため、ここでは、この約4時間スケジュール実行が動かなかったことだけを結果として扱います（スケジュールを1日1回に直した後の結果は、このセクションの後半に書きます）。

**確認役の「Drift Detect Watch」も、スケジュールで動くはずが、この間1回も動いていません。** 手動で起動すれば、検知が止まっていることを正しく報告しました。しかし、確認役が検知と同じスケジュールの仕組みに頼っていると、スケジュールが止まったときには、確認役も一緒に止まります。止まったことを知らせるはずの仕組みが、同じ理由で止まっていました。

### ■ 検証内容：ランナーを止めて、検知の停止を確かめる

スケジュールが動かないため、ここからは手動の起動で確かめます。self-hostedランナーを待つ点は、スケジュールで起動した実行でも、手動で起動した実行でも同じです。

まず、ランナーが動いている状態で「Drift Detect」を起動し（「Drift Detect」の実行#8）、3環境とも差分なしで成功させました。続けて「Drift Detect Watch」を起動しました（「Drift Detect Watch」の実行#2）。

**▼ 実行結果**（「Drift Detect Watch」の実行#2、`watch`ジョブから抜粋）

```plaintext
#8 workflow_dispatch completed success created=2026-10-25T09:27:06Z updated=2026-10-25T09:29:10Z
（途中省略：#7〜#1）
last_success=2026-10-25T09:29:10Z waiting_runs=0
age_minutes=1 max_age_minutes=40
```

そのうえで、self-hostedランナーを止め、「Drift Detect」を起動しました（「Drift Detect」の実行#9）。

**実行コマンド**

```plaintext
sudo systemctl stop actions.runner.juehara-crypto-ansible-terraform-ci-lab.ubuntu-controller.service
systemctl is-active actions.runner.juehara-crypto-ansible-terraform-ci-lab.ubuntu-controller.service
date '+%F %T %Z'
```

**▼ 実行結果**

```plaintext
inactive
2026-10-25 09:34:10 UTC
```

**▼ 実行結果**（「Drift Detect」の実行#9、`detect`ジョブの画面の表示）

```plaintext
Requested labels: self-hosted, Linux, X64
Job defined at: juehara-crypto/ansible-terraform-ci-lab/.github/workflows/drift-detect.yml@refs/heads/main
Waiting for a runner to pick up this job...
```

実行#9は失敗にならず、`Queued`のまま進みませんでした。最後の成功から40分を過ぎるまで待ち、「Drift Detect Watch」を起動しました（「Drift Detect Watch」の実行#3）。

**▼ 実行結果**（「Drift Detect Watch」の実行#3、`watch`ジョブから抜粋）

```plaintext
#9 workflow_dispatch queued null created=2026-10-25T09:38:54Z updated=2026-10-25T09:38:54Z
#8 workflow_dispatch completed success created=2026-10-25T09:27:06Z updated=2026-10-25T09:29:10Z
（途中省略：#7〜#1）
last_success=2026-10-25T09:29:10Z waiting_runs=1
age_minutes=44 max_age_minutes=40
##[error]last successful Drift Detect finished 44 minutes ago
##[error]Process completed with exit code 1.
```

最後に、ランナーを起動し、待っていた実行#9が終わった後に、もう一度「Drift Detect Watch」を起動しました（「Drift Detect Watch」の実行#4）。

**実行コマンド**

```plaintext
sudo systemctl start actions.runner.juehara-crypto-ansible-terraform-ci-lab.ubuntu-controller.service
systemctl is-active actions.runner.juehara-crypto-ansible-terraform-ci-lab.ubuntu-controller.service
date '+%F %T %Z'
```

**▼ 実行結果**

```plaintext
active
2026-10-25 10:16:18 UTC
```

**▼ 実行結果**（「Drift Detect」の実行#9、`detect`ジョブから抜粋）

```plaintext
2026-10-25T10:16:33.5530769Z Current runner version: '2.338.0'
（途中省略）
2026-10-25T10:17:15.4236233Z RESULT dev=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
2026-10-25T10:17:44.5176125Z RESULT stg=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
2026-10-25T10:18:24.6535954Z RESULT prod=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
```

**▼ 実行結果**（「Drift Detect Watch」の実行#4、`watch`ジョブから抜粋）

```plaintext
#9 workflow_dispatch completed success created=2026-10-25T09:38:54Z updated=2026-10-25T10:18:33Z
（途中省略：#8〜#1）
last_success=2026-10-25T10:18:33Z waiting_runs=0
age_minutes=6 max_age_minutes=40
```

### ■ 結果

時刻を並べると、次のとおりです。

|時刻（UTC）|出来事|
|---|---|
|09:29:10|「Drift Detect」の実行#8が成功（最後の成功）|
|09:34:10|self-hostedランナーを停止|
|09:38:54|「Drift Detect」の実行#9を起動。ランナーを待ったまま進まない|
|10:13:20|「Drift Detect Watch」の実行#3：最後の成功が44分前、待っている実行が1件で、失敗|
|10:16:18|self-hostedランナーを起動|
|10:16:33|実行#9のジョブが始まる（起動から約37分半の待ち）|
|10:18:33|実行#9が成功|
|10:25:17|「Drift Detect Watch」の実行#4：最後の成功が6分前、待っている実行は0件で、成功|

ランナーが止まっている間、検知の実行は失敗にならず、待ったままでした。検知の側からは、何も報告されていません。それを報告したのは、ホステッドランナーで動く確認役でした。確認役は、最後の成功が古いことに加えて、待っている実行が1件あることも出しているため、「検知がそもそも起動されていない」のか、「起動されたがランナーを待っている」のかも区別できます。

### ■ 検証内容：確認役に、スケジュールとは別のきっかけを持たせる

確認役がスケジュールだけで動くと、スケジュールが止まったときに一緒に止まります。そこで、「GitOps Pipeline」または「GitOps Apply」の実行が終わるたびにも、確認役が動くようにしました（`workflow_run`）。変更をマージしたとき、適用したときに、検知が最近成功しているかが確かめられます。

あわせて、スケジュールを運用の間隔に直しました。「Drift Detect」は1日1回（日本時間6:17）、「Drift Detect Watch」はその30分後と、パイプラインの実行の後に動きます。最後の成功の許容は26時間（1560分）にしています。15分ごとのままにしなかったのは、ホステッドランナーの利用時間に、非公開リポジトリでは月2,000分（GitHub Freeの場合）という枠があるためでもあります。15分ごとに動かし続けると、1日96回、月に3,000回近く動くことになります。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops18-detect-watch-trigger
sed -i "s|- cron: '5,20,35,50 \* \* \* \*'|- cron: '17 21 * * *'|" .github/workflows/drift-detect.yml
sed -i "s|- cron: '10,25,40,55 \* \* \* \*'|- cron: '47 21 * * *'|" .github/workflows/drift-detect-watch.yml
sed -i "s|^  workflow_dispatch:\$|  workflow_dispatch:\n  workflow_run:\n    workflows: [GitOps Pipeline, GitOps Apply]\n    types: [completed]|" .github/workflows/drift-detect-watch.yml
sed -i "s|MAX_AGE_MINUTES: 40|MAX_AGE_MINUTES: 1560|" .github/workflows/drift-detect-watch.yml
git --no-pager diff
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops18-detect-watch-trigger'
diff --git a/.github/workflows/drift-detect-watch.yml b/.github/workflows/drift-detect-watch.yml
index f783852..e757ab3 100644
--- a/.github/workflows/drift-detect-watch.yml
+++ b/.github/workflows/drift-detect-watch.yml
@@ -2,8 +2,11 @@ name: Drift Detect Watch

 on:
   schedule:
-    - cron: '10,25,40,55 * * * *'
+    - cron: '47 21 * * *'
   workflow_dispatch:
+  workflow_run:
+    workflows: [GitOps Pipeline, GitOps Apply]
+    types: [completed]

 permissions:
   actions: read
@@ -16,7 +19,7 @@ jobs:
       - name: Check last successful Drift Detect
         env:
           GH_TOKEN: ${{ github.token }}
-          MAX_AGE_MINUTES: 40
+          MAX_AGE_MINUTES: 1560
         run: |
           set -euo pipefail
           runs=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/drift-detect.yml/runs?per_page=20")
diff --git a/.github/workflows/drift-detect.yml b/.github/workflows/drift-detect.yml
index 506980b..2c9a9a9 100644
--- a/.github/workflows/drift-detect.yml
+++ b/.github/workflows/drift-detect.yml
@@ -2,7 +2,7 @@ name: Drift Detect

 on:
   schedule:
-    - cron: '5,20,35,50 * * * *'
+    - cron: '17 21 * * *'
   workflow_dispatch:
     inputs:
       compare_with:
```

この変更をプルリクエスト（PR#91）にしました。確認の実行（「GitOps Pipeline」の実行#166）の後には、「Drift Detect Watch」は動いていません。この時点では、mainのワークフローのファイルに、まだ`workflow_run`のきっかけがないためです。PR#91をマージすると（マージコミット`8895790`、「GitOps Pipeline」の実行#167）、実行#167が終わった約11秒後に、「Drift Detect Watch」が自動で動きました（「Drift Detect Watch」の実行#5）。

**▼ 実行結果**（「Drift Detect Watch」の実行#5、`watch`ジョブから抜粋）

```plaintext
2026-10-25T10:36:08.3226890Z Complete job name: watch
（途中省略）
#9 workflow_dispatch completed success created=2026-10-25T09:38:54Z updated=2026-10-25T10:18:33Z
（途中省略：#8〜#1）
last_success=2026-10-25T10:18:33Z waiting_runs=0
age_minutes=17 max_age_minutes=1560
```


翌朝、1日1回に直したスケジュールが動くかを確かめました。

|ワークフロー|予定（日本時間）|実際（日本時間）|
|---|---|---|
|「Drift Detect」|6:17|8:16:11に実行#13が作られた（約1時間59分遅れ）|
|「Drift Detect Watch」|6:47|8:33:52に実行#11のジョブが始まった（約1時間47分遅れ）|

**▼ 実行結果**（「Drift Detect Watch」の実行#11、`watch`ジョブから抜粋）

```plaintext
2026-10-25T23:33:52.7331249Z Complete job name: watch
（途中省略）
  MAX_AGE_MINUTES: 1560
#13 schedule completed success created=2026-10-25T23:16:11Z updated=2026-10-25T23:18:19Z
（途中省略：#12〜#1は、すべてworkflow_dispatch）
last_success=2026-10-25T23:18:19Z waiting_runs=0
age_minutes=15 max_age_minutes=1560
```

「Drift Detect」の実行#13のきっかけは`schedule`で、2つのワークフローとも、予定から2時間近く遅れて動きました。この検証の間、スケジュール実行は、動かないことも、2時間近く遅れて動くこともありました。確認役の許容を、検知の間隔（24時間）ちょうどではなく26時間にしているため、この程度の遅れでは、確認役は失敗しません。

### ■ 結果

パイプラインの実行が終わると、手動で起動しなくても、確認役が検知の最後の成功を確かめるようになりました。ここまでで、検知が止まる経路と、気づける仕組みの関係は次のようになります。

|止まる経路|検知のワークフロー|確認役（「Drift Detect Watch」）|
|---|---|---|
|self-hostedランナーが止まる|失敗せず、待ったまま|最後の成功が古いこと、待っている実行があることを報告する|
|スケジュール実行が動かない|起動されない|スケジュールだけに頼ると、確認役も一緒に止まる。パイプラインの実行の後には動く|
|スケジュールが動かず、パイプラインも使われない|起動されない|動かない|

最後の行は、この形でも残ります。スケジュールが動かず、誰もパイプラインを使わない期間は、確認役も動きません。この穴を埋めるには、GitHubの外にある仕組み（外部のスケジューラーから`workflow_dispatch`で起動する、監視の仕組みから実行の一覧を確かめるなど）を使うことになります。どこまで埋めるかは、検知が何日止まっていても許されるかで決まります。

ただし、確認役が失敗しても、その失敗を誰かが見なければ、気づいたことにはなりません。確認役の失敗も、検知の「差分あり」も、ワークフローの実行の一覧に並ぶだけです。次のセクションでは、検知の結果をどこに残すかを扱います。

---

[↑ 目次に戻る](#-目次)

---

## 6. 検知結果をどこに残すか

検知の結果と、確認役の結果を、GitHubのIssueに残します。

### 結果は、ワークフローの実行の一覧に並ぶだけでは足りない

ここまでの検知の結果は、ワークフローの実行のログの中にしかありません。**[セクション3](#3-検知結果を3つに分ける)** で、「差分あり」ではジョブを失敗にしないと決めたため、差分ありの検知も、実行の一覧には成功として並びます。毎日1回動けば、1か月で30件の成功が並び、その中のどれに差分があったかは、ログを1件ずつ開かないと分かりません。

結果を残す場所には、次の3つが必要です。

* 差分あり・検知失敗の間は、目に見える状態で残り続ける
* 同じドリフトが続いても、記録が増えない（毎日1件ずつ増えると、**[セクション1](#1-はじめに)** の「誰も報告を見なくなった」と同じことが起きる）
* 解消したら、解消したことが分かる形で終わる

ここでは、リポジトリのIssueを使います。開いている・閉じているの状態を持ち、本文を書き換えられ、閉じるときにコメントを残せます。外部のサービスを使わないため、GitHubのトークン（`GITHUB_TOKEN`）に`issues: write`の権限を足すだけで済みます。

Issueの使い方は、次のように決めました。

|結果|その環境のIssueが開いていない|その環境のIssueが開いている|
|---|---|---|
|差分あり・検知失敗|作る|本文を最新の結果で書き換える（コメントは足さない）|
|差分なし|何もしない|「解消しました。」のコメントを付けて閉じる|

* Issueは、環境ごとに1つ（タイトル`[drift-detect] dev`、`[drift-detect] stg`、`[drift-detect] prod`）と、確認役のための1つ（`[drift-detect] 検知の停止`）
* 同じタイトルの開いているIssueがあるかどうかで、作るか書き換えるかを決める
* 比べる相手が`main`の手動の起動（**[セクション2](#2-mainと比べると未適用の差分を誤報する)** の比べ方の確認用では、Issueに残さない

### ■ 検証内容：Issueに残すスクリプトと、2つのワークフローの変更

Issueを操作する処理は、2つのワークフローで共通のスクリプトにまとめました。GitHubのAPIは、「GitOps Apply」と同じく`curl`と`jq`で呼びます。

**▼ 実行結果**（`cat -n .github/scripts/report-issue.sh`）

```plaintext
     1  #!/usr/bin/env bash
     2  # 検知の結果を、タイトルで決まる1つのIssueに残す
     3  #   report-issue.sh <タイトル> open  <本文のファイル>  開いていなければ作り、開いていれば本文を書き換える
     4  #   report-issue.sh <タイトル> close <本文のファイル>  開いていればコメントを付けて閉じる
     5  # 終了コード 0=成功、2=使い方の誤り（APIの失敗はcurlの終了コード）
     6  set -euo pipefail
     7  [ $# -eq 3 ] || { echo "usage: report-issue.sh <title> <open|close> <body_file>" >&2; exit 2; }
     8  title="$1"; action="$2"; body_file="$3"
     9  api="https://api.github.com/repos/$GITHUB_REPOSITORY"
    10  auth=(-H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json")
    11  num=$(curl -fsSL "${auth[@]}" "$api/issues?state=open&per_page=100" \
    12    | jq -r --arg t "$title" '[.[] | select(.pull_request == null and .title == $t) | .number] | first // empty')
    13  case "$action" in
    14    open)
    15      if [ -z "$num" ]; then
    16        num=$(jq -n --arg title "$title" --rawfile body "$body_file" '{title: $title, body: $body}' \
    17          | curl -fsSL "${auth[@]}" -X POST "$api/issues" -d @- | jq -r .number)
    18        echo "issue #$num created: $title"
    19      else
    20        jq -n --rawfile body "$body_file" '{body: $body}' \
    21          | curl -fsSL "${auth[@]}" -X PATCH "$api/issues/$num" -d @- > /dev/null
    22        echo "issue #$num updated: $title"
    23      fi
    24      ;;
    25    close)
    26      if [ -n "$num" ]; then
    27        jq -n --rawfile body "$body_file" '{body: ("解消しました。\n\n" + $body)}' \
    28          | curl -fsSL "${auth[@]}" -X POST "$api/issues/$num/comments" -d @- > /dev/null
    29        curl -fsSL "${auth[@]}" -X PATCH "$api/issues/$num" -d '{"state": "closed", "state_reason": "completed"}' > /dev/null
    30        echo "issue #$num closed: $title"
    31      else
    32        echo "no open issue: $title"
    33      fi
    34      ;;
    35    *)
    36      echo "usage: report-issue.sh <title> <open|close> <body_file>" >&2
    37      exit 2
    38      ;;
    39  esac
```

* 11〜12行目：開いているIssueを読み、タイトルが一致するものの番号を取り出す。GitHubのAPIでは、プルリクエストもIssueの一覧に含まれるため、`pull_request`を持つものは除く
* 14〜24行目：開いていなければ作り、開いていれば本文だけを書き換える
* 25〜34行目：開いていれば、「解消しました。」に続けて最新の結果をコメントに残し、閉じる。開いていなければ何もしない

「Drift Detect」は、環境ごとの結果とIssueの本文をファイルに書き出し、新しいステップでスクリプトを呼ぶようにしました。

**▼ 実行結果**（`cat -n .github/workflows/drift-detect.yml`から抜粋）

```plaintext
    20  permissions:
    21    contents: read
    22    issues: write
（途中省略）
    91              echo "RESULT $e=$result plan_exit_code=$plan_rc check_exit_code=$check_rc changed=$changed failed_hosts=$failed_hosts"
    92              printf '%s\n' "$result" > "$RUNNER_TEMP/result-$e"
    93              {
    94                echo "- 結果: $result"
    95                echo "- 比べたコミット: ${ref:-（取得できず）}"
    96                echo "- plan_exit_code=$plan_rc check_exit_code=$check_rc changed=$changed failed_hosts=$failed_hosts"
    97                echo "- 実行: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
    98                echo "- 時刻: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    99                if [ -s "$out" ]; then
   100                  echo
   101                  jq -r '.plays[].tasks[] | .task.name as $t | .hosts | to_entries[] | select(.value.changed == true) | "- changed: \(.key) \($t)"' "$out" || true
   102                fi
   103              } > "$RUNNER_TEMP/report-$e.md"
（途中省略）
   107        - name: Report to issues
   108          if: ${{ always() && (inputs.compare_with || 'last-applied') == 'last-applied' }}
   109          env:
   110            GH_TOKEN: ${{ github.token }}
   111          run: |
   112            for e in dev stg prod; do
   113              if [ ! -f "$RUNNER_TEMP/result-$e" ]; then
   114                echo "$e: no result"
   115                continue
   116              fi
   117              if [ "$(cat "$RUNNER_TEMP/result-$e")" = "no_drift" ]; then
   118                action=close
   119              else
   120                action=open
   121              fi
   122              .github/scripts/report-issue.sh "[drift-detect] $e" "$action" "$RUNNER_TEMP/report-$e.md"
   123            done
```

* 22行目：Issueを作る・書き換えるための`issues: write`を足した
* 92行目：環境ごとの結果（`no_drift`・`drift`・`detect_failed`）をファイルに書き出す
* 93〜103行目：Issueの本文に、結果、比べたコミット、4つの値、実行のURL、時刻、`changed`になったホストとタスクを書き出す。本文を開けば、どのホストのどのタスクで差分が出たかまで分かる
* 108行目：検知が「検知失敗」でジョブを失敗にした後も動く（`always()`）。比べる相手が`main`の起動では動かない
* 117〜121行目：差分なしなら閉じ、それ以外（差分あり・検知失敗）なら開く

確認役の「Drift Detect Watch」も、同じスクリプトで`[drift-detect] 検知の停止`を開く・閉じるようにしました。

**▼ 実行結果**（`cat -n .github/workflows/drift-detect-watch.yml`から抜粋）

```plaintext
     6    workflow_dispatch:
     7      inputs:
     8        max_age_minutes:
     9          description: '最後の成功の許容（分）。空なら1560'
    10          type: string
    11          default: ''
（途中省略）
    16  permissions:
    17    actions: read
    18    contents: read
    19    issues: write
（途中省略）
    25        - uses: actions/checkout@v4
    26        - name: Check last successful Drift Detect
    27          id: check
    28          env:
    29            GH_TOKEN: ${{ github.token }}
    30            MAX_AGE_MINUTES: ${{ inputs.max_age_minutes || '1560' }}
（途中省略）
    48            {
    49              echo "- 最後の成功: ${last:-なし}"
    50              echo "- 経過（分）: ${age:-不明}（許容 $MAX_AGE_MINUTES）"
    51              echo "- 待っている実行: $waiting"
    52              echo "- 確認した実行: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
    53            } > "$RUNNER_TEMP/watch-report.md"
    54            echo "stale=$stale" >> "$GITHUB_OUTPUT"
    55            if [ "$stale" -eq 1 ]; then
    56              echo "::error::$msg"
    57              exit 1
    58            fi
    59        - name: Report to issues
    60          if: ${{ always() && steps.check.outputs.stale != '' }}
    61          env:
    62            GH_TOKEN: ${{ github.token }}
    63            STALE: ${{ steps.check.outputs.stale }}
    64          run: |
    65            if [ "$STALE" = "1" ]; then action=open; else action=close; fi
    66            .github/scripts/report-issue.sh "[drift-detect] 検知の停止" "$action" "$RUNNER_TEMP/watch-report.md"
```

* 6〜11行目、30行目：手動の起動で、許容時間（分）を指定できるようにした。空なら1560分。この後の検証で、許容を0分にして「古い」状態を作るために使う
* 25行目：共通のスクリプトを使うため、リポジトリを取り出す
* 48〜58行目：古いときにすぐ失敗させず、Issueの本文を書き出し、判定（`stale`）を後のステップに渡してから失敗させる
* 59〜66行目：古ければ`[drift-detect] 検知の停止`を開き、そうでなければ閉じる。60行目の条件で、判定の前に失敗したとき（`stale`が空のとき）は動かない

この変更をプルリクエスト（PR#92）にし、確認の実行（「GitOps Pipeline」の実行#168）とマージの実行（「GitOps Pipeline」の実行#169）で`changes`ジョブだけが動いたことを確かめました（マージコミット`7272ae4`）。

**[セクション5](#5-検知が止まったことに気づく)** で加えた`workflow_run`のきっかけにより、「Drift Detect Watch」は2回動いています。`workflow_run`で動くのは、mainにあるワークフローのファイルです。そのため、確認の実行#168の後の「Drift Detect Watch」の実行#6は、マージの前のファイルで動き、権限に`Issues: write`がなく、Issueに残すステップもありませんでした。マージの実行#169の後の実行#7は、マージの後のファイルで動いています。

**▼ 実行結果**（「Drift Detect Watch」の実行#7、`watch`ジョブから抜粋）

```plaintext
Issues: write
（途中省略）
age_minutes=736 max_age_minutes=1560
（途中省略）
no open issue: [drift-detect] 検知の停止
```

### ■ 検証内容：同じドリフトで、2回検知する

prodのtarget-node1のファイルを、パイプラインを通さずに書き換えます（**[セクション3](#3-検知結果を3つに分ける)** と同じ書き換えです。**[セクション3](#3-検知結果を3つに分ける)** で見たとおり、止まったコンテナに`plan`を流すとコンテナが削除されたため、ここではコンテナを止めずに、ファイルだけを変えます）。

**実行コマンド**

```plaintext
docker exec target-node1 cat /etc/drift-check-target.conf
docker exec target-node1 sed -i 's/ansible-drift-check/manual-edit/' /etc/drift-check-target.conf
docker exec target-node1 cat /etc/drift-check-target.conf
```

**▼ 実行結果**

```plaintext
monitored_by=ansible-drift-check
monitored_by=manual-edit
```

この状態で、「Drift Detect」を`last-applied`で起動しました（「Drift Detect」の実行#10）。

**▼ 実行結果**（「Drift Detect」の実行#10、`detect`ジョブから抜粋）

```plaintext
RESULT dev=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
RESULT stg=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
changed: target-node1 common_setup : ドリフト検知の実演用設定ファイルを配置
RESULT prod=drift plan_exit_code=0 check_exit_code=0 changed=1 failed_hosts=0
（途中省略）
no open issue: [drift-detect] dev
no open issue: [drift-detect] stg
issue #93 created: [drift-detect] prod
```

Issue#93`[drift-detect] prod`が作られました。devとstgは差分なしで、開いているIssueがないため、何もしていません。

**▼ 実行結果**（Issue#93の本文、画面の表示）

```plaintext
- 結果: drift
- 比べたコミット: 2edd63f
- plan_exit_code=0 check_exit_code=0 changed=1 failed_hosts=0
- 実行: https://github.com/juehara-crypto/ansible-terraform-ci-lab/actions/runs/40241874229
- 時刻: 2026-10-25T22:50:07Z

- changed: target-node1 common_setup : ドリフト検知の実演用設定ファイルを配置
```

ファイルは`manual-edit`のまま、何も変えずに、もう一度「Drift Detect」を起動しました（「Drift Detect」の実行#11）。

**▼ 実行結果**（「Drift Detect」の実行#11、`detect`ジョブから抜粋）

```plaintext
RESULT prod=drift plan_exit_code=0 check_exit_code=0 changed=1 failed_hosts=0
（途中省略）
no open issue: [drift-detect] dev
no open issue: [drift-detect] stg
issue #93 updated: [drift-detect] prod
```

**▼ 実行結果**（Issue#93の本文、画面の表示から抜粋）

```plaintext
- 実行: https://github.com/juehara-crypto/ansible-terraform-ci-lab/actions/runs/40242451360
- 時刻: 2026-10-25T22:57:59Z
```

新しいIssueは作られず、開いているIssueはIssue#93の1件のままでした。本文の「実行」と「時刻」が実行#11のものに書き換わり、コメントは0件のままです。

### ■ 検証内容：ドリフトを戻して、検知する

**実行コマンド**

```plaintext
docker exec target-node1 sed -i 's/manual-edit/ansible-drift-check/' /etc/drift-check-target.conf
docker exec target-node1 cat /etc/drift-check-target.conf
```

**▼ 実行結果**

```plaintext
monitored_by=ansible-drift-check
```

「Drift Detect」を起動しました（「Drift Detect」の実行#12）。

**▼ 実行結果**（「Drift Detect」の実行#12、`detect`ジョブから抜粋）

```plaintext
RESULT dev=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
RESULT stg=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
RESULT prod=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
（途中省略）
no open issue: [drift-detect] dev
no open issue: [drift-detect] stg
issue #93 closed: [drift-detect] prod
```

**▼ 実行結果**（Issue#93のコメント、画面の表示）

```plaintext
解消しました。

- 結果: no_drift
- 比べたコミット: 2edd63f
- plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
- 実行: https://github.com/juehara-crypto/ansible-terraform-ci-lab/actions/runs/40243014358
- 時刻: 2026-10-25T23:05:29Z
```

Issue#93は`Closed`になり、Issuesのタブでは、開いているIssueが0件、閉じたIssueが1件（Issue#93）になりました。

### ■ 検証内容：確認役のIssueを確かめる

確認役の`[drift-detect] 検知の停止`は、検知を止めずに確かめるため、許容時間を手動の起動の入力で0分にして、「古い」状態を作ります。

まず、入力に`0`を入れて「Drift Detect Watch」を起動しました（「Drift Detect Watch」の実行#8）。

**▼ 実行結果**（「Drift Detect Watch」の実行#8、`watch`ジョブから抜粋）

```plaintext
  MAX_AGE_MINUTES: 0
（途中省略）
last_success=2026-10-25T23:05:41Z waiting_runs=0
age_minutes=8 max_age_minutes=0
##[error]last successful Drift Detect finished 8 minutes ago
##[error]Process completed with exit code 1.
（途中省略）
  STALE: 1
（途中省略）
issue #94 created: [drift-detect] 検知の停止
```

ステップ「Check last successful Drift Detect」が失敗した後も、ステップ「Report to issues」が動き、Issue#94が作られました。

**▼ 実行結果**（Issue#94の本文、画面の表示）

```plaintext
- 最後の成功: 2026-10-25T23:05:41Z
- 経過（分）: 8（許容 0）
- 待っている実行: 0
- 確認した実行: https://github.com/juehara-crypto/ansible-terraform-ci-lab/actions/runs/40243848213
```

続けて、入力を`0`のまま、もう一度起動しました（「Drift Detect Watch」の実行#9）。この間に、「Drift Detect」の実行#13がスケジュールで動いています（**[セクション5](#5-検知が止まったことに気づく)** の、約2時間遅れて動いた実行です）。

**▼ 実行結果**（「Drift Detect Watch」の実行#9、`watch`ジョブから抜粋）

```plaintext
  MAX_AGE_MINUTES: 0
#13 schedule completed success created=2026-10-25T23:16:11Z updated=2026-10-25T23:18:19Z
（途中省略）
last_success=2026-10-25T23:18:19Z waiting_runs=0
age_minutes=2 max_age_minutes=0
##[error]last successful Drift Detect finished 2 minutes ago
##[error]Process completed with exit code 1.
（途中省略）
issue #94 updated: [drift-detect] 検知の停止
```

確認役でも、「古い」状態が続く間は、新しいIssueは作られず、Issue#94の本文が書き換えられました（最後の成功が実行#13の`23:18:19Z`、経過が2分）。

最後に、入力を空にして起動しました（「Drift Detect Watch」の実行#10）。

**▼ 実行結果**（「Drift Detect Watch」の実行#10、`watch`ジョブから抜粋）

```plaintext
  MAX_AGE_MINUTES: 1560
（途中省略）
last_success=2026-10-25T23:18:19Z waiting_runs=0
age_minutes=6 max_age_minutes=1560
（途中省略）
  STALE: 0
（途中省略）
issue #94 closed: [drift-detect] 検知の停止
```

**▼ 実行結果**（Issue#94のコメント、画面の表示）

```plaintext
解消しました。

- 最後の成功: 2026-10-25T23:18:19Z
- 経過（分）: 6（許容 1560）
- 待っている実行: 0
- 確認した実行: https://github.com/juehara-crypto/ansible-terraform-ci-lab/actions/runs/40244631921
```

### ■ 結果

検知の結果と確認役の結果は、どちらもIssueの状態として残るようになりました。

|起きたこと|Issue|検証での実行|
|---|---|---|
|prodにドリフトが出た|Issue#93を作った|「Drift Detect」の実行#10|
|同じドリフトが続いた|Issue#93の本文を書き換えた（コメントは0件のまま）|「Drift Detect」の実行#11|
|ドリフトが解消した|コメントを付けてIssue#93を閉じた|「Drift Detect」の実行#12|
|検知の最後の成功が古くなった|Issue#94を作った|「Drift Detect Watch」の実行#8|
|古い状態が続いた|Issue#94の本文を書き換えた|「Drift Detect Watch」の実行#9|
|古い状態が解消した|コメントを付けてIssue#94を閉じた|「Drift Detect Watch」の実行#10|

開いているIssueを見れば、今ずれている環境と、検知が止まっているかどうかが分かります。本文はいつも最新の結果で、閉じたIssueのコメントには、解消を確かめた実行が残ります。同じドリフトが何日続いても、Issueは1件のままです。

この検証で確かめたのは、「差分あり」と、確認役の「古い」です。「検知失敗」も、スクリプトの呼び方は「差分あり」と同じで、その環境のIssueを開きます。結果の欄に`detect_failed`と書かれるため、ずれているのか、確かめられなかったのかは、Issueの本文で見分けられます。

---

[↑ 目次に戻る](#-目次)

---

## 7. 複数環境での検知

昇格の途中で、環境ごとに最後に適用したコミットが違う状態を作り、検知が環境ごとに独立した結果を出すことを確かめます。

### 昇格の途中では、比べるコードが環境ごとに違う

**[セクション2](#2-mainと比べると未適用の差分を誤報する)** 〜 **[セクション6](#6-検知結果をどこに残すか)** の検証では、3環境とも、最後に適用したコミットが同じ`2edd63f`でした。承認ゲートと昇格の順序を持つパイプラインでは、この状態は、すべての環境に適用し終えた後の一時的なものです。変更をマージしてからprodに適用するまでの間は、devだけが新しいコミットを適用し、stgとprodは前のコミットのまま、という状態が続きます。

検知は、環境ごとに`applied.sh last <環境>`で最後に適用したコミットを読み、そのコミットのコードで比べます。昇格の途中でも、各環境は、それぞれが最後に適用したコードと比べられるはずです。ここでは、その状態を実際に作って確かめます。

### ■ 検証内容：devにだけ適用する

`/etc/gitops-env.conf`に1行を足す変更（Ansibleだけの変更）をプルリクエスト（PR#95）にし、確認の実行（「GitOps Pipeline」の実行#170）を経てマージしました（マージコミット`83e3a65`、「GitOps Pipeline」の実行#171）。マージの実行で、3環境の承認待ちが作られます。

**実行コマンド**

```plaintext
for e in dev stg prod; do echo "== $e"; for f in commit terraform ansible; do echo "$f=$(cat ~/gitops-pending/$e/$f)"; done; done
```

**▼ 実行結果**

```plaintext
== dev
commit=83e3a65499377e2267886b316cb3e177140c3ecb
terraform=false
ansible=true
== stg
commit=83e3a65499377e2267886b316cb3e177140c3ecb
terraform=false
ansible=true
== prod
commit=83e3a65499377e2267886b316cb3e177140c3ecb
terraform=false
ansible=true
```

このうち、devの承認待ちだけを「GitOps Apply」で適用しました（「GitOps Apply」の実行#96）。Terraformの変更がないため、`terraform-apply`ジョブはスキップされ、`ansible-apply`ジョブだけが適用しています。

**実行コマンド**

```plaintext
psql "$PG_CONN_STR" -X -c 'SELECT id, env, commit_sha FROM gitops.applied ORDER BY id DESC LIMIT 4;'
for n in dev-node1 stg-node1 target-node1; do echo "== $n"; docker exec $n cat /etc/gitops-env.conf; done
```

**▼ 実行結果**

```plaintext
 id | env  |                commit_sha
----+------+------------------------------------------
 62 | dev  | 83e3a65499377e2267886b316cb3e177140c3ecb
 61 | prod | 2edd63fd1580c3832e6faebf25915365dd8f7fcb
 60 | stg  | 2edd63fd1580c3832e6faebf25915365dd8f7fcb
 59 | dev  | 2edd63fd1580c3832e6faebf25915365dd8f7fcb
(4 rows)

== dev-node1
env=dev
promotion=dev-stg-prod
gitops17=pending-check
gitops18=pending-detect
gitops18=promote-check
== stg-node1
env=stg
promotion=dev-stg-prod
gitops17=pending-check
gitops18=pending-detect
== target-node1
env=prod
promotion=dev-stg-prod
gitops17=pending-check
gitops18=pending-detect
```

devの最後に適用したコミットは`83e3a65`、stgとprodは`2edd63f`のままです。新しい1行は、dev-node1にだけ入っています。

この状態で、「Drift Detect」を`last-applied`で起動しました（「Drift Detect」の実行#14）。

**▼ 実行結果**（「Drift Detect」の実行#14、`detect`ジョブから抜粋）

```plaintext
== dev
compare_with=last-applied ref=83e3a65499377e2267886b316cb3e177140c3ecb
（途中省略）
No changes. Your infrastructure matches the configuration.
（途中省略）
RESULT dev=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
== stg
compare_with=last-applied ref=2edd63fd1580c3832e6faebf25915365dd8f7fcb
（途中省略）
RESULT stg=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
== prod
compare_with=last-applied ref=2edd63fd1580c3832e6faebf25915365dd8f7fcb
（途中省略）
RESULT prod=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
（途中省略）
no open issue: [drift-detect] dev
no open issue: [drift-detect] stg
no open issue: [drift-detect] prod
```

devは`83e3a65`のコードと、stgとprodは`2edd63f`のコードと比べられ、3環境とも差分なしでした。stgとprodには、`gitops18=promote-check`の1行が適用を待っていますが、差分としては報告されていません。

### ■ 検証内容：devだけにドリフトを作る

昇格の途中の状態のまま、dev-node1の`/etc/drift-check-target.conf`だけを、パイプラインを通さずに書き換えました（コンテナは止めていません）。

**実行コマンド**

```plaintext
docker exec dev-node1 cat /etc/drift-check-target.conf
docker exec dev-node1 sed -i 's/ansible-drift-check/manual-edit/' /etc/drift-check-target.conf
docker exec dev-node1 cat /etc/drift-check-target.conf
```

**▼ 実行結果**

```plaintext
monitored_by=ansible-drift-check
monitored_by=manual-edit
```

「Drift Detect」を起動しました（「Drift Detect」の実行#15）。

**▼ 実行結果**（「Drift Detect」の実行#15、`detect`ジョブから抜粋）

```plaintext
== dev
compare_with=last-applied ref=83e3a65499377e2267886b316cb3e177140c3ecb
（途中省略）
{"dev-node1":{"changed":1,"failures":0,"ignored":0,"ok":6,"rescued":0,"skipped":0,"unreachable":0}}
changed: dev-node1 common_setup : ドリフト検知の実演用設定ファイルを配置
RESULT dev=drift plan_exit_code=0 check_exit_code=0 changed=1 failed_hosts=0
== stg
compare_with=last-applied ref=2edd63fd1580c3832e6faebf25915365dd8f7fcb
（途中省略）
RESULT stg=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
== prod
compare_with=last-applied ref=2edd63fd1580c3832e6faebf25915365dd8f7fcb
（途中省略）
RESULT prod=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
（途中省略）
issue #96 created: [drift-detect] dev
no open issue: [drift-detect] stg
no open issue: [drift-detect] prod
```

**▼ 実行結果**（Issue#96の本文、画面の表示）

```plaintext
- 結果: drift
- 比べたコミット: 83e3a65
- plan_exit_code=0 check_exit_code=0 changed=1 failed_hosts=0
- 実行: https://github.com/juehara-crypto/ansible-terraform-ci-lab/actions/runs/40250069206
- 時刻: 2026-10-26T00:35:33Z

- changed: dev-node1 common_setup : ドリフト検知の実演用設定ファイルを配置
```

devだけが差分ありになり、`[drift-detect] dev`のIssue#96だけが作られました。Issueの本文の「比べたコミット」は、devが最後に適用した`83e3a65`です。

### ■ 検証内容：ドリフトを戻し、stgとprodを追いつかせる

dev-node1のファイルを戻し、stgとprodの承認待ちを、stg→prodの順に適用しました（「GitOps Apply」の実行#97・#98）。

**実行コマンド**

```plaintext
docker exec dev-node1 sed -i 's/manual-edit/ansible-drift-check/' /etc/drift-check-target.conf
docker exec dev-node1 cat /etc/drift-check-target.conf
```

**▼ 実行結果**

```plaintext
monitored_by=ansible-drift-check
```

**実行コマンド**（2つの適用の後）

```plaintext
ls -la ~/gitops-pending
psql "$PG_CONN_STR" -X -c 'SELECT id, env, commit_sha FROM gitops.applied ORDER BY id DESC LIMIT 3;'
for n in dev-node1 stg-node1 target-node1 target-node2 target-node3; do echo "== $n"; docker exec $n cat /etc/gitops-env.conf | tail -1; done
```

**▼ 実行結果**

```plaintext
total 8
drwx------  2 control control 4096 Oct 26 00:47 .
drwxr-x--- 14 control control 4096 Oct 26 00:24 ..
 id | env  |                commit_sha
----+------+------------------------------------------
 64 | prod | 83e3a65499377e2267886b316cb3e177140c3ecb
 63 | stg  | 83e3a65499377e2267886b316cb3e177140c3ecb
 62 | dev  | 83e3a65499377e2267886b316cb3e177140c3ecb
(3 rows)

== dev-node1
gitops18=promote-check
== stg-node1
gitops18=promote-check
== target-node1
gitops18=promote-check
== target-node2
gitops18=promote-check
== target-node3
gitops18=promote-check
```

「Drift Detect」を起動しました（「Drift Detect」の実行#16）。

**▼ 実行結果**（「Drift Detect」の実行#16、`detect`ジョブから抜粋）

```plaintext
== dev
compare_with=last-applied ref=83e3a65499377e2267886b316cb3e177140c3ecb
（途中省略）
RESULT dev=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
== stg
compare_with=last-applied ref=83e3a65499377e2267886b316cb3e177140c3ecb
（途中省略）
RESULT stg=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
== prod
compare_with=last-applied ref=83e3a65499377e2267886b316cb3e177140c3ecb
（途中省略）
RESULT prod=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
（途中省略）
issue #96 closed: [drift-detect] dev
no open issue: [drift-detect] stg
no open issue: [drift-detect] prod
```

### ■ 結果

3回の検知で、環境ごとに比べたコミットと結果は次のようになりました。

|「Drift Detect」の実行|状態|dev|stg|prod|
|---|---|---|---|---|
|実行#14|devだけ適用済み|`83e3a65`と比べ、差分なし|`2edd63f`と比べ、差分なし|`2edd63f`と比べ、差分なし|
|実行#15|devだけ適用済み、devにドリフト|`83e3a65`と比べ、差分あり（Issue#96を作成）|`2edd63f`と比べ、差分なし|`2edd63f`と比べ、差分なし|
|実行#16|3環境とも適用済み|`83e3a65`と比べ、差分なし（Issue#96を閉じた）|`83e3a65`と比べ、差分なし|`83e3a65`と比べ、差分なし|

昇格の途中でも、各環境は、それぞれが最後に適用したコミットのコードと比べられました。適用を待っている変更は、どの環境でも差分として報告されていません。比べる相手を`main`にしていれば、実行#14と#15のstgとprodは、**[セクション2](#2-mainと比べると未適用の差分を誤報する)** の実行#3と同じく、未適用の1行を差分ありとして報告していたはずです。

ドリフトも、環境ごとに独立して扱われました。devのドリフトは、devのIssueだけを作り、stgとprodのIssueには何も起きていません。stgとprodが追いついて比べるコミットが変わった後も、devのドリフトが解消していれば、devのIssueは閉じられます。

なお、この検証の間も、「GitOps Pipeline」と「GitOps Apply」の実行が終わるたびに、**[セクション5](#5-検知が止まったことに気づく)** の確認役が動き、検知の最後の成功が古くないことを確かめていました。

---

[↑ 目次に戻る](#-目次)

---

## 8. クラウドでも同じ設計で検知できる

この回の検証は、Dockerのプロバイダーで行いました。クラウドのプロバイダーで定期検知を行うときに加わる点と、プロバイダーによらず同じ点を整理します。

### 実環境を変える経路が増える

この検証環境で、パイプラインを通さずに実環境を変えたのは、`docker exec`でコンテナの中のファイルを書き換える操作でした。クラウドでは、これに加えて、次のような経路でも実環境が変わります。

* 管理コンソールやCLIからの、人の手による変更
* クラウドの別の自動化の仕組みや、ほかのツールからの変更

どの経路から変わっても、検知が比べるのは、最後に適用したコミットのコードと実環境です。経路が増えても、検知の仕組みは変わりません。

ただし、Terraformの`lifecycle`の`ignore_changes`で外した属性は、実際のオブジェクトと設定が違っていても、`plan`の差分に出ません。外部の仕組みが値を書き換える属性を外しておくと、その属性は、この回の検知の範囲から外れます。何を外しているかは、検知で見えない範囲の一覧でもあります。

### 定期的な`plan`は、クラウドのAPIを読む

`plan`は、既定で、すでにある実際のオブジェクトの現在の状態を読んでから、設定と比べます。クラウドでは、この読み取りの1つ1つが、クラウドのAPIの呼び出しになります。同時に動かす操作の数（`-parallelism`）の既定は10です。

APIの呼び出しには制限があります。たとえばAmazon EC2のAPIでは、制限はAWSアカウントごと、リージョンごとにかかり、超えた要求には`RequestLimitExceeded`が返ります。読み取りの操作は、一般に制限が最も大きく設定されています。それでも、検知の`plan`は、同じアカウント・リージョンで動く適用や、ほかの自動化と同じ制限を使います。

制限に当たったときの扱いは、**[セクション3](#3-検知結果を3つに分ける)** の判定がそのまま使えます。AWSのSDKは自動で再試行しますが、それでも`plan`がエラーで終われば、終了コードは1で、結果は「検知失敗」になります。「差分なし」としては数えられません。

### 接続元と認証情報

クラウドのAPIは、インターネットから届く場所にあります。そのため、Terraformの`plan`だけなら、ホステッドランナーからも届きます。ただし、Ansibleの接続先がプライベートなネットワークの中にあれば、**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** で確かめたとおり、ホステッドランナーからは届きません。TerraformとAnsibleの両方で比べる検知は、この回と同じく、操作対象に届くランナーで動かします。

ホステッドランナーで動かせるのは、**[セクション5](#5-検知が止まったことに気づく)** の確認役のように、操作対象に届かなくてよい処理です。確認役が読むのはGitHubのAPIだけなので、クラウドでもそのまま使えます。

検知が使う認証情報は、クラウドでは、クラウドのアカウントへの認証情報になります。GitHub ActionsのOIDCを使うと、ジョブごとに有効な、短い期間のトークンをクラウドから受け取れます。長く使う認証情報を、シークレットとしてGitHubに置かずに済みます。検知は読み取りだけで済むため、適用とは別の、読み取りだけの権限を持つロールを使う形にもできます。

### stateのロックは、バックエンドの設定による

**[セクション4](#4-検知と適用の衝突)** では、pgバックエンドで、検知の`plan`がstateのロックを取ることを確かめました。クラウドでよく使われるS3バックエンドでは、ロックは自分で有効にする機能で、`use_lockfile`の既定は`false`です（DynamoDBによるロックは非推奨になっています）。ロックを有効にしていなければ、`-lock-timeout`は効かず、検知の`plan`と適用が重なっても、どちらも止まりません。同時実行のグループで順に動かす設計は、ロックの有無にかかわらず、パイプラインの中どうしの重なりを防ぎます。

### プロバイダーによらず同じこと

|設計|この回で確かめたこと|プロバイダーとの関係|
|---|---|---|
|比べる相手|環境ごとに最後に適用したコミットのコードと比べる（**[セクション2](#2-mainと比べると未適用の差分を誤報する)**、**[セクション7](#7-複数環境での検知)**）|最後に適用したコミットの記録は、パイプラインの側にある|
|結果の3分類|`plan`の終了コードと、確認モードの`stats`から、「差分なし」「差分あり」「検知失敗」に分ける（**[セクション3](#3-検知結果を3つに分ける)**）|`plan`の終了コードの意味は、プロバイダーによらない|
|検知の停止|最後の成功の時刻を、別の場所から確かめる（**[セクション5](#5-検知が止まったことに気づく)**）|読むのはGitHubのAPIだけ|
|結果の残し方|環境ごとに1つのIssueを、開く・書き換える・閉じる（**[セクション6](#6-検知結果をどこに残すか)**）|読むのは検知の結果だけ|

クラウドで変わるのは、実環境を変える経路、APIの制限、接続元と認証情報、ロックの設定です。何と何を比べ、結果をどう分け、止まったことにどう気づくかは、プロバイダーによって変わりません。

---

[↑ 目次に戻る](#-目次)

---

## 9. まとめ

この回で整理した内容を確認します。

* 定期検知で、mainのコードと実環境を比べると、承認や昇格を待っているだけの変更が「差分あり」として報告される。未適用の差分がある状態で、mainと比べた検知は3環境とも差分ありを報告し、環境ごとに最後に適用したコミットと比べた検知は差分なしを報告することを、実機で確かめた。検知は、`gitops.applied`から最後に適用したコミットを読み、`git worktree`でそのコミットのコードを取り出して比べる
* 検知の結果は、「差分なし」「差分あり」「検知失敗」の3つに分ける。`ansible-playbook`の出力を`tee`につなぐと、終了コード4が隠れて0になり、`changed`の数も0と読めた。そこで、Terraformは`plan -detailed-exitcode`の終了コードを、Ansibleは確認モードの終了コードとJSONの`stats`を使って判定する。接続できないホストがある検知は、「差分なし」ではなく「検知失敗」になる。この検証環境では、止まったコンテナに`plan`を流すと、コンテナが削除された
* 検知の`plan`も、stateのロックを取る。パイプラインの外からロックを持たれた状態では、検知の`plan`は`Error acquiring the state lock`で失敗し、検知失敗になった。検知を、適用と同じ同時実行のグループに入れ、`-lock-timeout=5m`でロックの空きを待つ形にすると、約1分51秒待った後に、差分なしで終わった。適用の途中のstateを読むおそれがあるため、`-lock=false`は採らない
* 検知は、失敗せずに止まる。15分ごとに置いたスケジュール実行は、約4時間、1回も動かなかった。1日1回に直した後は、予定から2時間近く遅れて動いた。self-hostedランナーを止めると、検知の実行は失敗にならず、ランナーを待ったままになった。これに気づけたのは、ホステッドランナーで動く確認役が、GitHubのAPIから最後の成功の時刻と待っている実行の数を読んで報告したときだけだった。確認役をスケジュールだけに頼らせず、パイプラインの実行が終わるたびにも動くようにした
* 検知の結果と確認役の結果は、環境ごとに1つのIssueに残す。差分ありならIssueを作り、同じ状態が続く間は本文を書き換え、解消したらコメントを付けて閉じる。同じドリフトで2回検知しても、Issueは1件のまま、コメントも増えないことを確かめた
* 昇格の途中で、環境ごとに最後に適用したコミットが違っても、各環境は、それぞれが最後に適用したコミットのコードと比べられた。devだけにドリフトを作ると、devのIssueだけが作られ、stgとprodには何も起きなかった
* クラウドでは、実環境を変える経路、APIの制限、接続元と認証情報、stateのロックの設定が加わる。何と何を比べ、結果をどう分け、止まったことにどう気づき、結果をどこに残すかは、プロバイダーを問わず同じである

---

[↑ 目次に戻る](#-目次)

---

## 10. 次回予告

本シリーズの **[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)** では、第4部の初回として、「main」「最後に適用したコミット」「実環境」の3つの状態を区別し、ツールの表示が同じ「差分あり」でも、記録と照らし合わせれば、未適用の差分とドリフトに分けられることを確かめました。第18回となる今回は、**[ドリフトシリーズ第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-04/)** の防ぐ・検知する・修正するのうち、「検知する」を扱いました。環境ごとに最後に適用したコミットのコードで、実環境を定期的に比べる検知を作り、結果を「差分なし」「差分あり」「検知失敗」の3つに分けました。検知の`plan`と適用のstateのロックの衝突を、同時実行のグループとロックの待ち時間で扱いました。検知そのものが止まったことには、ホステッドランナーで動く確認役から気づけるようにしました。結果は環境ごとに1つのIssueに残し、昇格の途中でも、各環境が自分の最後に適用したコミットと比べられることを確かめました。最後に、この設計がクラウドのプロバイダーでも変わらないことを示しました。

**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** では、「修正する」を扱います。今回の検知は、ドリフトを見つけてIssueに残すところで止まっていて、実環境は人が戻しています。次回は、検知したドリフトを、人の介入なしに戻す自動収束を作ります。収束先は、mainではなく、承認を経て適用された状態（最後に適用したコミット）に限ります。mainに戻すと、承認を待っている変更まで適用してしまい、承認ゲートと矛盾するためです。あわせて、再生成・削除・再作成を伴う変更や、今回の「検知失敗」は、自動で収束させずに人に返します。収束しないPlaybookによって、収束が繰り返し続くことも止めます。

**[次回：第19回：ドリフトを検知したら自動収束させる](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)**

---

📑 連載の移動　**[前の記事：【GitOps編】第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)　｜　[次の記事：【GitOps編】第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第4部まとめブログ：ドリフトの区別・検知・収束・例外・予防を「最後に適用したコミット」でつなぐ** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 11. 連載一覧：「Ansible×TerraformをGitOpsで回す」

### 第4部：ドリフト検知と自動収束

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)**|GitOps環境でドリフトはなぜ起きるのか|ドリフトシリーズの、記述されていない要素は比較の対象にならないというルールが、Ansible・Terraform・GitOpsの3か所で現れることを示す。第1回の3つの経路が第2部・第3部を経ても残ることと、承認・昇格・revertが生む食い違いを整理する。「main」「最後に適用したコミット」「実環境」の3つの状態を区別し、マージ済みで未適用の状態とコンテナの属性の手動変更を実機で作って、未適用の差分とドリフトを記録で見分ける。第4部の初回。|
|**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)**|定期実行でドリフトを自動検知する|環境ごとに「最後に適用したコミット」のコードで実環境を比べ、結果を「差分なし」「差分あり」「検知失敗」の3つに分ける定期検知を作る。stateのロックとの衝突を同時実行のグループとロックの待ち時間で扱い、検知が止まったことをホステッドランナーの確認役から気づけるようにする。結果を環境ごとに1つのIssueに残し、昇格の途中の複数環境でも環境ごとに独立して検知できることを確かめる。Ansible×Terraformシリーズ第37回の深掘り版として位置づける。|
|**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)**|ドリフトを検知したら自動収束させる|収束先を承認済みの状態（最後に適用したコミット）に限定し、承認ゲートと矛盾しない自動収束を作る。再生成・削除・再作成や検知失敗は人に返し、収束しないPlaybookによる無限の収束を止める。|
|**[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-20/)**|緊急対応の手動変更とGitOpsを両立させる|障害対応で加えた手動変更を自動収束が元に戻してしまう問題を扱う。Gitを経由する高速経路と、自動収束の一時停止・バックポートを、記録と期限を持つ「設計された例外経路」として組み込む。|
|**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)**|検知できないドリフトを減らす：管理対象の範囲を広げる設計|検知も自動収束もできない「記述・記録されていない乖離」を扱い、ドリフトシリーズ第4回の「防ぐ」をGitOps上で実装する。管理外のものを実際の状態とPlaybook・tfstateとの突き合わせで洗い出し、「取り込む」「削除する」「管理外と宣言する」に振り分けてすべてをGitに記録する。第4部・シリーズの最終回。|

---

[↑ 目次に戻る](#-目次)

---