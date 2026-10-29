---
title: '「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第19回：ドリフトを検知したら自動収束させる'
description: '定期検知で見つけたドリフトを、人の介入なしに戻す自動収束を、GitOpsのパイプラインの上に作る。収束先をmainにすると承認を待っている変更まで適用されることを確かめ、収束先を環境ごとに最後に適用したコミットに限る。検知時に保存したplanで検知した差分だけを戻し、作り直し・削除・作成を伴う変更と検知失敗は人に返す。収束の前にガードレールの結果を確かめ、収束の後の再検知で、収束しないPlaybookによる繰り返しを止める。自動収束が直せないものを整理し、障害対応の手動変更がIssueにも残らないまま戻されることを確かめる。ドリフトシリーズ第4回の「修正する」を、承認ゲートと矛盾しない形で実装する回。'
pubDate: 2026-10-26
category: 'infra'
tags: ['Ansible', 'Terraform', 'GitOps', 'ドリフト', '自動収束']
seriesId: 'ansible-gitops-part4'
seriesNo: 19
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-20/'
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
2. [mainへ収束させると承認ゲートを迂回する](#2-mainへ収束させると承認ゲートを迂回する)
3. [検知した内容だけを適用する](#3-検知した内容だけを適用する)
4. [自動で戻す変更と人に返す変更](#4-自動で戻す変更と人に返す変更)
5. [収束の順序と前提条件](#5-収束の順序と前提条件)
6. [収束しないPlaybookを止める](#6-収束しないplaybookを止める)
7. [自動収束が直せないもの](#7-自動収束が直せないもの)
8. [手動変更は自動で消される](#8-手動変更は自動で消される)
9. [クラウドでも同じ設計で収束できる](#9-クラウドでも同じ設計で収束できる)
10. [まとめ](#10-まとめ)
11. [次回予告](#11-次回予告)
12. [連載一覧：「Ansible×TerraformをGitOpsで回す」](#12-連載一覧ansibleterraformをgitopsで回す)

---

## 1. はじめに

TerraformとAnsibleのパイプラインに、ドリフトを定期的に検知する仕組みを入れていて、

* 定期検知で、ドリフトを見つけられるようになった
* 見つけたら、`terraform apply`と`ansible-playbook`を自動で流せばよい
* よって、人の手を介さずに、実際のインフラを常にGitに書いたとおりの状態に保てる

と考えていないでしょうか。

ドリフトの自動収束を扱う記事の多くは、Argo CDやFluxのように、管理対象の側で常駐するエージェントが継続的に収束させる構成か、「差分があれば適用する」という単純な構成を前提にしています。承認ゲートを持つパイプラインの中で、何に戻すのか、何を自動で戻してはいけないのか、どこで止まるべきなのかは、あまり扱われていません。検知の後に自動で適用する処理を加えると、次のような場面にぶつかります。

* 自動収束が、承認を待っていた変更まで適用してしまった
* 自動収束でコンテナが作り直され、Ansibleで入れた設定が消えた
* 実行のたびに「変更あり」になり、収束が終わらない
* 障害対応で直した設定が、次の定期実行で元に戻された

これらは、収束の処理の書き方や、実行のタイミングの問題に見えます。共通しているのは、自動収束が何に戻すのか、どの変更なら人の承認なしに戻してよいのか、そして収束がうまくいかないときにどこで止まるのかが、決まっていない点です。

ドリフトへの対処の設計は、**[「Ansibleは冪等なのに、なぜサーバは壊れていくのか」](https://qiita.com/juehara-crypto/items/2a375a2c0fca3a8df0ca)**（以下、ドリフトシリーズ）で扱いました。

|回|扱った内容|
|---|---|
|**[ドリフトシリーズ第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-04/)**|ドリフトへの対処を、防ぐ・検知する・修正するの3つの設計に整理した。修正する設計では、自動修正は迅速に対処できる一方で意図的な変更を上書きするおそれがあり、人の判断は内容を確かめてから直せる一方で対処までに空白が生まれるとし、どちらにするかを事前に決めておく必要があるとした|

検知の結果に応じた自動収束そのものは、「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」（以下、Ansible×Terraformシリーズ）でも扱いました。

|回|扱った内容|
|---|---|
|**[Ansible×Terraformシリーズ第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)**|`ansible-playbook --check`の出力の`changed=`の値を合算し、0でなければ同じコードで本実行して収束させるワークフロー「Drift Check」を作った。収束させたのはAnsibleの側だけで、収束先は、そのとき実行したコードだった。実行のたびに使い捨てられるホステッドランナーで、コンテナの起動から改ざんの注入、検知、収束までを、1回のワークフローの実行の中で完結させる構成だった|

本シリーズでは、これまでの回で、次の整理と仕組みを積み上げてきました。

|部|回|扱った内容|
|---|---|---|
|第2部|**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)**|パイプラインの実行を、同時実行のグループ（`gitops-pipeline`、`queue: max`）で直列化した。Terraformはこの直列化とstateのロックの二重で守られる一方、Ansibleを守るのは直列化だけで、パイプラインの外から実行したAnsibleは止められないことを確かめた|
|第2部|**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**|マージで作ったplanを承認待ちとして保存し、手動の起動を承認とする承認ゲートを作った。保存したplanは、作った後にtfstateが変わると`Saved plan is stale`で適用を拒否されることを確かめた。ゲートが止めるのは内容ではなくタイミングであり、承認されずに残った差分はドリフトではないと整理した|
|第2部|**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)**|ansible-lintとMoleculeの結果を、適用の前に確かめる構成を作った。収束しないPlaybookが自動収束に載ると、存在しないずれを直し続けることになると予告した。`changed_when: false`のように表示を変えるだけの書き方は、2つのチェックをすり抜けることも確かめた|
|第2部|**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)**|planのJSONから、作り直しと削除を含む変更を見つけて止める判定を作り、承認ゲートの入口に置いた|
|第2部|**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)**|dev、stg、prodの順にしか適用できない昇格の仕組みを作り、環境ごとに「最後に適用したコミット」を記録した。作り直しと削除は、devでは通し、stgとprodでは人が明示して許可する形にした|
|第4部|**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)**|「main」「最後に適用したコミット」「実環境」の3つの状態を区別し、mainと最後に適用したコミットの差を未適用の差分、最後に適用したコミットと実環境の差をドリフトとして分けた。ドリフトには、Terraformの`plan`で検出できるもの、Ansibleの`--check`で検出できるもの、どちらでも検出できないものがあると整理した|
|第4部|**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)**|環境ごとに最後に適用したコミットのコードで実環境を比べ、結果を「差分なし」「差分あり」「検知失敗」の3つに分ける定期検知「Drift Detect」を作った。検知が止まったことに気づく確認役と、環境ごとに1つのIssueに結果を残す仕組みも加えた。止まったコンテナに対して検知の`plan`を実行すると、コンテナが削除されることも確かめた|

**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** の検知は、ドリフトを見つけてIssueに残すところで止まっていて、実環境は人が戻していました。一方で、**[Ansible×Terraformシリーズ第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** の形のまま、差分があればそのまま適用する処理を加えると、承認ゲートを通っていない変更までインフラに届くおそれがあります。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** では、人の承認なしに適用系を動かさないゲートを作りました。自動収束は、人の承認なしに適用系を動かす仕組みです。この2つを、どう両立させるかが問題になります。

第19回となる今回は、**[ドリフトシリーズ第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-04/)** の「修正する」を、GitOpsのパイプラインの上に作ります。まず、収束先をmainにすると、承認を待っている変更まで適用されることを確かめ、収束先を環境ごとに最後に適用したコミットに限ります。次に、検知の時点で保存したplanを適用し、検知で見つけた差分だけを戻す形にします。そのうえで、自動で戻してよい変更と、人に判断を返す変更を分け、収束の順序と、収束の前に確かめる条件を整えます。続けて、収束しないPlaybookによって収束が繰り返し続くことを止める仕組みを作ります。さらに、自動収束では直せないものと、障害対応のような手動変更まで自動収束が元に戻してしまうことを確かめます。最後に、この設計がクラウドのプロバイダーでも変わらないことを示します。手動変更と自動収束を両立させる設計は **[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-20/)** で、自動収束では直せない範囲を狭める設計は **[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)** で扱います。

正確に言うと、**自動収束は、最新のmainに合わせることではなく、承認を経て適用した状態に戻すことです。何を自動で戻してよいか、どこで止まるべきかを決めて初めて、承認ゲートと矛盾せずに動かせます**。この回で扱う問いは、「人の承認なしに、何を、どこまで自動で戻してよいのか」です。

次のセクションでは、自動収束の収束先をどこに置くべきかを確認します。

---

[↑ 目次に戻る](#-目次)

---

## 2. mainへ収束させると承認ゲートを迂回する

自動収束の収束先を、mainにした場合と、環境ごとに最後に適用したコミットにした場合で比べ、自動収束が何に戻すべきかを決めます。

### 自動収束は、人の承認なしに適用系を動かす

**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** では、適用系を手動の起動に分け、人が承認の材料を見て起動したときにだけ、インフラが変わる形にしました。自動収束は、検知の後に、人の起動を待たずに本実行する仕組みです。人の承認を経ずに適用系を動かす以上、何のコードで本実行するかによって、承認ゲートとの関係が変わります。

**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)** で整理した3つの状態に当てはめると、次のとおりです。

|収束先|本実行で実環境に入るもの|承認ゲートとの関係|
|---|---|---|
|mainの先頭|ドリフトを戻す変更と、未適用の差分（承認や昇格を待っている変更）|承認を待っている変更が、承認なしに入る|
|環境ごとに最後に適用したコミット|ドリフトを戻す変更だけ|承認を経て適用した状態に戻すだけで、新しい変更は入らない|

**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション6では、承認ゲートが止めているのは内容ではなくタイミングだと整理しました。最後に適用したコミットは、その内容を、人がすでに承認して適用したコミットです。そこに戻すことは、新しい内容を届けることではなく、承認済みの内容を、もう一度実環境に当てはめ直すことになります。

**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** の「Drift Detect」は、比べるコードを`compare_with`の入力で、`last-applied`（環境ごとに最後に適用したコミット）と`main`（mainの先頭）から選べます。この回では、差分ありと判定した環境を、比べたコードでそのまま本実行する自動収束を加え、2つの収束先を同じワークフローで比べます。

### ■ 検証内容：「Drift Detect」に自動収束を加える

「Drift Detect」に、次の3か所を加えました。

**▼ 実行結果**（`git diff`、「Drift Detect」の変更）

```plaintext
@@ -12,6 +12,10 @@ on:
           - last-applied
           - main
         default: last-applied
+      converge:
+        description: '差分ありの環境を、比べたコードで本実行して戻す'
+        type: boolean
+        default: false

 concurrency:
   group: gitops-pipeline
@@ -52,6 +56,7 @@ jobs:
       - name: Detect drift
         env:
           COMPARE_WITH: ${{ inputs.compare_with || 'last-applied' }}
+          CONVERGE: ${{ inputs.converge == true }}
           PG_CONN_STR: ${{ secrets.PG_CONN_STR }}
           TF_VAR_deploy_user_password: ${{ secrets.TF_VAR_DEPLOY_USER_PASSWORD }}
           ANSIBLE_VAULT_PASSWORD_GITOPS16: ${{ secrets.ANSIBLE_VAULT_PASSWORD_GITOPS16 }}
@@ -101,6 +106,21 @@ jobs:
                 jq -r '.plays[].tasks[] | .task.name as $t | .hosts | to_entries[] | select(.value.changed == true) | "- changed: \(.key) \($t)"' "$out" || true
               fi
             } > "$RUNNER_TEMP/report-$e.md"
+            if [ "$CONVERGE" = "true" ] && [ "$result" = "drift" ]; then
+              tf_rc=-1; ans_rc=-1
+              if [ "$plan_rc" -eq 2 ]; then
+                tf_rc=0
+                terraform -chdir="$wt/terraform/envs/$e" apply -input=false -no-color -auto-approve -lock-timeout=5m || tf_rc=$?
+              fi
+              if [ "$tf_rc" -le 0 ]; then
+                ans_rc=0
+                (cd "$wt/ansible" && ansible-playbook -i "inventories/$e" site.yml --diff --vault-id "gitops16@$GITHUB_WORKSPACE/.github/scripts/vault-pass-client.sh") || ans_rc=$?
+              fi
+              echo "CONVERGE $e ref=$ref terraform_apply_exit_code=$tf_rc ansible_exit_code=$ans_rc"
+              if [ "$tf_rc" -gt 0 ] || [ "$ans_rc" -gt 0 ]; then
+                failed=1
+              fi
+            fi
             git worktree remove --force "$wt" 2> /dev/null || true
           done
           exit $failed
```

加えた内容は、次のとおりです。

* 手動の起動の入力に`converge`を加えた。既定は`false`で、スケジュール実行では入力が空になるため、自動収束は動かない
* 結果が差分あり（`drift`）の環境でだけ、検知に使ったコード（`git worktree`で取り出したコミット）で本実行する
* Terraformは、`plan`に差分があったとき（`plan_exit_code=2`）だけ`apply`する。この時点では、`plan`を計算し直して適用する形にしている（**[セクション3](#3-検知した内容だけを適用する)** で置き換える）
* Ansibleは、Terraformの`apply`が失敗しなかったときに本実行する。**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** と同じく、Terraform→Ansibleの順になる
* 収束の結果を`CONVERGE`の1行で表示し、Terraformの`apply`かAnsibleの本実行が失敗したときは、ジョブを失敗にする

この変更をプルリクエスト（PR#97）にし、確認の実行（「GitOps Pipeline」の実行#172）で`changes`ジョブだけが動いたことを確かめて、マージしました（マージコミット`daa4014`、「GitOps Pipeline」の実行#173）。

### ■ 検証内容：マージ済みで未適用の状態を作る

**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** のセクション2と同じく、`/etc/gitops-env.conf`に1行を足す変更をマージし、承認待ちのまま、どの環境にも適用しない状態を作ります。今回は、Ansibleの変更だけにしました。Terraformの変更を含めると、収束先をmainにしたときに、自動収束がtfstateを書き換え、残している承認待ちのplanが適用できなくなるためです。

最初は、これまでと同じく`content`の1行の文字列に足しましたが、その行が167文字になり、ansible-lintの`yaml[line-length]`（上限160文字）で失敗しました（PR#98、「GitOps Pipeline」の実行#174・#175）。**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** のセクション7で確かめたとおり、チェックが失敗したままでもマージでき、承認待ちも作られます。そこで、`content`をYAMLのブロックで書き直す変更をプルリクエスト（PR#99）にし、ansible-lintとMoleculeが成功することを確かめてマージしました（マージコミット`0358b1a`、「GitOps Pipeline」の実行#176・#177）。書き出されるファイルの中身は、足した1行のほかは変わりません。

**▼ 実行結果**（`cat -n ansible/roles/common_setup/tasks/environment.yml`）

```plaintext
     1  ---
     2  - name: 環境の名前を書いたファイルを配置
     3    become: true
     4    ansible.builtin.copy:
     5      dest: /etc/gitops-env.conf
     6      content: |
     7        env={{ common_setup_env }}
     8        promotion=dev-stg-prod
     9        gitops17=pending-check
    10        gitops18=pending-detect
    11        gitops18=promote-check
    12        gitops19=pending-converge
    13      mode: "0644"
```

**▼ 実行結果**（「GitOps Pipeline」の実行#177、`record-pending`ジョブから抜粋）

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
== dev
（途中省略：ファイルの一覧）
commit=0358b1a4362d4873a56aad5d96c08fa4cca453ce
terraform=false
ansible=true
== stg
（途中省略：devと同じ形の表示）
== prod
（途中省略：devと同じ形の表示）
```

3環境の承認待ちが、マージコミット`0358b1a`で作られました。この承認待ちは、適用せずに残します。

### ■ 検証内容：devにドリフトを作る

dev-node1の`/etc/drift-check-target.conf`を、パイプラインを通さずに書き換え、5台の`/etc/gitops-env.conf`の最後の行を確かめます。

**実行コマンド**

```plaintext
docker exec dev-node1 cat /etc/drift-check-target.conf
docker exec dev-node1 sed -i 's/ansible-drift-check/manual-edit/' /etc/drift-check-target.conf
docker exec dev-node1 cat /etc/drift-check-target.conf
for n in dev-node1 stg-node1 target-node1 target-node2 target-node3; do echo "== $n"; docker exec $n tail -1 /etc/gitops-env.conf; done
```

**▼ 実行結果**

```plaintext
monitored_by=ansible-drift-check
monitored_by=manual-edit
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

これで、次の状態になりました。

|項目|状態|
|---|---|
|main|`0358b1a`（`gitops19=pending-converge`を足すコード）|
|最後に適用したコミット|3環境とも`83e3a65`（足す前のコード）|
|承認待ち|3環境とも`0358b1a`で、適用していない|
|ドリフト|dev-node1の`/etc/drift-check-target.conf`が`manual-edit`|

### ■ 検証内容：収束先をmainにして自動収束させる

「Drift Detect」を、`compare_with`を`main`、`converge`を有効にして起動しました（「Drift Detect」の実行#17）。

**▼ 実行結果**（「Drift Detect」の実行#17、`detect`ジョブのステップ「Detect drift」から抜粋）

```plaintext
（途中省略：実行したスクリプト、シェルの表示）
  COMPARE_WITH: main
  CONVERGE: true
（途中省略：環境変数の表示）
== dev
compare_with=main ref=0358b1a4362d4873a56aad5d96c08fa4cca453ce
（途中省略：Refreshing state...によるリソース一覧の出力）
No changes. Your infrastructure matches the configuration.
（途中省略）
{"dev-node1":{"changed":2,"failures":0,"ignored":0,"ok":6,"rescued":0,"skipped":0,"unreachable":0}}
changed: dev-node1 common_setup : ドリフト検知の実演用設定ファイルを配置
changed: dev-node1 common_setup : 環境の名前を書いたファイルを配置
RESULT dev=drift plan_exit_code=0 check_exit_code=0 changed=2 failed_hosts=0

PLAY [接続確認用Playbook] ******************************************************

TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] *******************
（途中省略：Pythonのインタープリターに関する警告）
--- before: /etc/drift-check-target.conf
+++ after: /etc/drift-check-target.conf
@@ -1 +1 @@
-monitored_by=manual-edit
+monitored_by=ansible-drift-check

changed: [dev-node1]

TASK [common_setup : 環境の名前を書いたファイルを配置] *************************
--- before: /etc/gitops-env.conf
+++ after: /etc/gitops-env.conf
@@ -3,3 +3,4 @@
 gitops17=pending-check
 gitops18=pending-detect
 gitops18=promote-check
+gitops19=pending-converge

changed: [dev-node1]
（途中省略：残りのタスクはok）
dev-node1                  : ok=6    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
CONVERGE dev ref=0358b1a4362d4873a56aad5d96c08fa4cca453ce terraform_apply_exit_code=-1 ansible_exit_code=0
== stg
compare_with=main ref=0358b1a4362d4873a56aad5d96c08fa4cca453ce
（途中省略：devと同じ形の表示。差分は環境の名前を書いたファイルの+gitops19=pending-convergeだけ）
RESULT stg=drift plan_exit_code=0 check_exit_code=0 changed=1 failed_hosts=0
（途中省略：本実行の表示）
CONVERGE stg ref=0358b1a4362d4873a56aad5d96c08fa4cca453ce terraform_apply_exit_code=-1 ansible_exit_code=0
== prod
compare_with=main ref=0358b1a4362d4873a56aad5d96c08fa4cca453ce
（途中省略：stgと同じ形の表示。3台とも+gitops19=pending-converge）
RESULT prod=drift plan_exit_code=0 check_exit_code=0 changed=3 failed_hosts=0
（途中省略：本実行の表示）
target-node1               : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
CONVERGE prod ref=0358b1a4362d4873a56aad5d96c08fa4cca453ce terraform_apply_exit_code=-1 ansible_exit_code=0
```

続けて、同じ入力でもう一度起動すると（「Drift Detect」の実行#18）、3環境とも差分なしでした。

**▼ 実行結果**（「Drift Detect」の実行#18、`detect`ジョブのステップ「Detect drift」から抜粋）

```plaintext
RESULT dev=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
RESULT stg=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
RESULT prod=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
```

手元で、実環境と記録を確かめます。

**実行コマンド**

```plaintext
for n in dev-node1 stg-node1 target-node1 target-node2 target-node3; do echo "== $n"; docker exec $n tail -1 /etc/gitops-env.conf; done
docker exec dev-node1 cat /etc/drift-check-target.conf
psql "$PG_CONN_STR" -X -c 'SELECT id, env, commit_sha FROM gitops.applied ORDER BY id DESC LIMIT 3;'
for e in dev stg prod; do echo "== $e"; cat ~/gitops-pending/$e/commit; done
```

**▼ 実行結果**

```plaintext
== dev-node1
gitops19=pending-converge
== stg-node1
gitops19=pending-converge
== target-node1
gitops19=pending-converge
== target-node2
gitops19=pending-converge
== target-node3
gitops19=pending-converge
monitored_by=ansible-drift-check
 id | env  |                commit_sha
----+------+------------------------------------------
 64 | prod | 83e3a65499377e2267886b316cb3e177140c3ecb
 63 | stg  | 83e3a65499377e2267886b316cb3e177140c3ecb
 62 | dev  | 83e3a65499377e2267886b316cb3e177140c3ecb
(3 rows)

== dev
0358b1a4362d4873a56aad5d96c08fa4cca453ce
== stg
0358b1a4362d4873a56aad5d96c08fa4cca453ce
== prod
0358b1a4362d4873a56aad5d96c08fa4cca453ce
```

### ■ 結果

mainのコードで比べると、3環境とも差分ありと判定されました。devの差分は、ドリフト（`manual-edit`）と、承認を待っている1行の2つです。stgとprodの差分は、承認を待っている1行だけで、ドリフトはありません。自動収束は、この差分をそのまま本実行で戻しました。

その結果、devのドリフトは戻りましたが、同時に、承認を待っていた`gitops19=pending-converge`の1行が、dev・stg・prodの5台すべてに入りました。「GitOps Apply」は1回も起動していません。prodには、承認の操作も、devとstgで先に確かめる昇格の順序も経ずに、変更が届いています。

しかも、最後に適用したコミットの記録は、3環境とも`83e3a65`のままで、承認待ちも`0358b1a`のまま残っています。記録の上では、この1行はまだどの環境にも適用されていません。mainへの収束は、承認ゲートを迂回したうえで、記録と実環境をずらしました。

`plan`はどの環境も差分なしだったため、Terraformの`apply`は動いていません（`terraform_apply_exit_code=-1`）。Terraformの変更が承認を待っていれば、それも同じく、承認なしに`apply`されていたことになります。

### ■ 検証内容：収束先を最後に適用したコミットにして自動収束させる

dev-node1の`/etc/drift-check-target.conf`を、もう一度書き換えます。

**実行コマンド**

```plaintext
docker exec dev-node1 sed -i 's/ansible-drift-check/manual-edit/' /etc/drift-check-target.conf
docker exec dev-node1 cat /etc/drift-check-target.conf
```

**▼ 実行結果**

```plaintext
monitored_by=manual-edit
```

「Drift Detect」を、`compare_with`を`last-applied`、`converge`を有効にして起動しました（「Drift Detect」の実行#19）。

**▼ 実行結果**（「Drift Detect」の実行#19、`detect`ジョブのステップ「Detect drift」と「Report to issues」から抜粋）

```plaintext
（途中省略：実行したスクリプト、シェルの表示）
  COMPARE_WITH: last-applied
  CONVERGE: true
（途中省略：環境変数の表示）
== dev
compare_with=last-applied ref=83e3a65499377e2267886b316cb3e177140c3ecb
（途中省略：Refreshing state...によるリソース一覧の出力）
No changes. Your infrastructure matches the configuration.
（途中省略）
{"dev-node1":{"changed":2,"failures":0,"ignored":0,"ok":6,"rescued":0,"skipped":0,"unreachable":0}}
changed: dev-node1 common_setup : ドリフト検知の実演用設定ファイルを配置
changed: dev-node1 common_setup : 環境の名前を書いたファイルを配置
RESULT dev=drift plan_exit_code=0 check_exit_code=0 changed=2 failed_hosts=0

PLAY [接続確認用Playbook] ******************************************************

TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] *******************
（途中省略：Pythonのインタープリターに関する警告）
--- before: /etc/drift-check-target.conf
+++ after: /etc/drift-check-target.conf
@@ -1 +1 @@
-monitored_by=manual-edit
+monitored_by=ansible-drift-check

changed: [dev-node1]

TASK [common_setup : 環境の名前を書いたファイルを配置] *************************
--- before: /etc/gitops-env.conf
+++ after: /etc/gitops-env.conf
@@ -3,4 +3,3 @@
 gitops17=pending-check
 gitops18=pending-detect
 gitops18=promote-check
-gitops19=pending-converge

changed: [dev-node1]
（途中省略：残りのタスクはok）
dev-node1                  : ok=6    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
CONVERGE dev ref=83e3a65499377e2267886b316cb3e177140c3ecb terraform_apply_exit_code=-1 ansible_exit_code=0
== stg
compare_with=last-applied ref=83e3a65499377e2267886b316cb3e177140c3ecb
（途中省略：devと同じ形の表示。差分は環境の名前を書いたファイルの-gitops19=pending-convergeだけ）
RESULT stg=drift plan_exit_code=0 check_exit_code=0 changed=1 failed_hosts=0
（途中省略：本実行の表示）
CONVERGE stg ref=83e3a65499377e2267886b316cb3e177140c3ecb terraform_apply_exit_code=-1 ansible_exit_code=0
== prod
compare_with=last-applied ref=83e3a65499377e2267886b316cb3e177140c3ecb
（途中省略：stgと同じ形の表示。3台とも-gitops19=pending-converge）
RESULT prod=drift plan_exit_code=0 check_exit_code=0 changed=3 failed_hosts=0
（途中省略：本実行の表示）
CONVERGE prod ref=83e3a65499377e2267886b316cb3e177140c3ecb terraform_apply_exit_code=-1 ansible_exit_code=0
（ステップ「Report to issues」）
issue #100 created: [drift-detect] dev
issue #101 created: [drift-detect] stg
issue #102 created: [drift-detect] prod
```

手元で、実環境と記録を確かめます。

**実行コマンド**

```plaintext
for n in dev-node1 stg-node1 target-node1 target-node2 target-node3; do echo "== $n"; docker exec $n tail -1 /etc/gitops-env.conf; done
docker exec dev-node1 cat /etc/drift-check-target.conf
psql "$PG_CONN_STR" -X -c 'SELECT id, env, commit_sha FROM gitops.applied ORDER BY id DESC LIMIT 3;'
for e in dev stg prod; do echo "== $e"; cat ~/gitops-pending/$e/commit; done
```

**▼ 実行結果**

```plaintext
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
monitored_by=ansible-drift-check
 id | env  |                commit_sha
----+------+------------------------------------------
 64 | prod | 83e3a65499377e2267886b316cb3e177140c3ecb
 63 | stg  | 83e3a65499377e2267886b316cb3e177140c3ecb
 62 | dev  | 83e3a65499377e2267886b316cb3e177140c3ecb
(3 rows)

== dev
0358b1a4362d4873a56aad5d96c08fa4cca453ce
== stg
0358b1a4362d4873a56aad5d96c08fa4cca453ce
== prod
0358b1a4362d4873a56aad5d96c08fa4cca453ce
```

### ■ 結果

2つの収束先を並べると、次のとおりです。

|項目|収束先がmain（「Drift Detect」の実行#17）|収束先が最後に適用したコミット（「Drift Detect」の実行#19）|
|---|---|---|
|比べたコード|`0358b1a`（mainの先頭）|`83e3a65`（3環境とも最後に適用したコミット）|
|devのドリフト|戻った|戻った|
|承認を待っている1行|5台すべてに入った|5台すべてから消えた|
|収束の後の実環境|mainの状態（記録とずれた）|最後に適用したコミットの状態（記録と一致した）|
|承認待ち|`0358b1a`のまま残った|`0358b1a`のまま残った|

最後に適用したコミットのコードで収束させると、devのドリフトが戻るのに加えて、「Drift Detect」の実行#17で承認なしに入った1行も、5台すべてから消えました。最後に適用したコミットには、この1行がないためです。自動収束が戻した先は、人が承認して適用した状態そのもので、承認を待っている変更には触れていません。承認待ちは、承認ゲートを通って適用される日を待ったまま残っています。

一方で、3環境のIssue（#100〜#102）が作られました。検知の結果はどの環境も差分ありで、Issueに残す処理は、自動収束で戻した後の状態を見ていないためです。自動収束の後に、戻ったことをどう確かめて残すかは、**[セクション6](#6-収束しないplaybookを止める)** で扱います。

### ■ 検証内容：承認待ちを適用し、Issueを閉じる

残している承認待ちを、「GitOps Apply」でdev（「GitOps Apply」の実行#99）、stg（実行#100）、prod（実行#101）の順に適用しました。どの実行も、`verify`、`ansible-apply`、`record-applied`が成功し、Terraformの変更がないため`terraform-apply`はスキップされています。そのうえで、「Drift Detect」を`compare_with`を`last-applied`、`converge`を無効にして起動しました（「Drift Detect」の実行#20）。

**▼ 実行結果**（「Drift Detect」の実行#20、`detect`ジョブから抜粋）

```plaintext
RESULT dev=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
RESULT stg=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
RESULT prod=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
（途中省略）
issue #100 closed: [drift-detect] dev
issue #101 closed: [drift-detect] stg
issue #102 closed: [drift-detect] prod
```

手元で、終了時点の状態を確かめます。

**実行コマンド**

```plaintext
ls -la ~/gitops-pending
psql "$PG_CONN_STR" -X -c 'SELECT id, env, commit_sha FROM gitops.applied ORDER BY id DESC LIMIT 3;'
for n in dev-node1 stg-node1 target-node1 target-node2 target-node3; do echo "== $n"; docker exec $n tail -1 /etc/gitops-env.conf; done
```

**▼ 実行結果**

```plaintext
total 8
drwx------  2 control control 4096 Oct 29 02:54 .
drwxr-x--- 14 control control 4096 Oct 29 01:44 ..
 id | env  |                commit_sha
----+------+------------------------------------------
 67 | prod | 0358b1a4362d4873a56aad5d96c08fa4cca453ce
 66 | stg  | 0358b1a4362d4873a56aad5d96c08fa4cca453ce
 65 | dev  | 0358b1a4362d4873a56aad5d96c08fa4cca453ce
(3 rows)

== dev-node1
gitops19=pending-converge
== stg-node1
gitops19=pending-converge
== target-node1
gitops19=pending-converge
== target-node2
gitops19=pending-converge
== target-node3
gitops19=pending-converge
```

### ■ 結果

承認待ちは空になり、3環境とも、最後に適用したコミットが`0358b1a`になりました。`gitops19=pending-converge`の1行は、今度は承認と昇格を経て、5台に入っています。3つのIssueも閉じられました。

同じ1行が実環境に入るのでも、「Drift Detect」の実行#17の自動収束では、記録にも承認待ちにも何も残らないまま入りました。「GitOps Apply」を通した今回は、どの環境に、どのコミットを、どの実行で適用したかが`gitops.applied`に残っています。

自動収束の収束先は、mainではなく、環境ごとに最後に適用したコミットに限る必要があります。そうすれば、自動収束は新しい変更を届ける仕組みではなく、承認済みの状態に戻す仕組みになり、人の承認なしに動かしても、承認ゲートと矛盾しません。ただし、この時点の自動収束は、Terraformの側で`plan`を計算し直してから適用しています。次のセクションでは、検知で見つけた差分だけを適用する形に変えます。

---

[↑ 目次に戻る](#-目次)

---

## 3. 検知した内容だけを適用する

検知の時点で保存したplanを、収束でそのまま適用する形に変え、自動収束が検知で見つけた差分だけを戻すこと、検知の後に前提が変わったときは止まることを確かめます。

### 収束の時点で計算し直すと、検知で見たものと違うものが適用されうる

**[セクション2](#2-mainへ収束させると承認ゲートを迂回する)** の自動収束は、Terraformの側で、収束の時点にあらためて`plan`を計算して適用していました。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション2で確かめたとおり、計画を計算し直すと、計算した時点の状態に対する計画が適用されます。検知から収束までの間に、手元からの適用などでtfstateが変われば、収束で適用されるのは、検知で見つけたのとは別の計画になりえます。

**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション3では、`terraform plan -out`で保存したplanは、計画を作った時点のtfstateの写しを持ち、作った後にtfstateが変わると`Saved plan is stale`で適用が拒否されることを確かめました。この仕組みを自動収束に当てはめ、検知の`plan`を保存し、収束ではそのplanを適用します。

Ansibleには、保存したplanに相当する仕組みがありません（**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション4）。Ansibleの側で絞れるのは、本実行する環境を、確認モードで差分ありと判定した環境に限ることまでです。

### ■ 検証内容：検知と収束を分け、保存したplanを適用する

「Drift Detect」のステップ「Detect drift」を、検知のループと収束のループの2つに分けました。

**▼ 実行結果**（`git diff`、「Drift Detect」の変更）

```plaintext
@@ -77,7 +77,7 @@ jobs:
             if [ -n "$ref" ] && git worktree add --detach "$wt" "$ref" > /dev/null \
               && terraform -chdir="$wt/terraform/envs/$e" init -input=false -lockfile=readonly > /dev/null; then
               plan_rc=0
-              terraform -chdir="$wt/terraform/envs/$e" plan -input=false -no-color -detailed-exitcode -lock-timeout=5m || plan_rc=$?
+              (umask 077; terraform -chdir="$wt/terraform/envs/$e" plan -input=false -no-color -detailed-exitcode -lock-timeout=5m -out="$RUNNER_TEMP/tfplan-$e") || plan_rc=$?
               check_rc=0
               (cd "$wt/ansible" && ANSIBLE_STDOUT_CALLBACK=ansible.posix.json ansible-playbook -i "inventories/$e" site.yml --check --diff --vault-id "gitops16@$GITHUB_WORKSPACE/.github/scripts/vault-pass-client.sh" > "$out") || check_rc=$?
               changed=$(jq '[.stats[].changed] | add // 0' "$out") || changed=-1
@@ -95,6 +95,7 @@ jobs:
             fi
             echo "RESULT $e=$result plan_exit_code=$plan_rc check_exit_code=$check_rc changed=$changed failed_hosts=$failed_hosts"
             printf '%s\n' "$result" > "$RUNNER_TEMP/result-$e"
+            printf '%s\n' "$plan_rc" > "$RUNNER_TEMP/plan_rc-$e"
             {
               echo "- 結果: $result"
               echo "- 比べたコミット: ${ref:-（取得できず）}"
@@ -106,22 +107,31 @@ jobs:
                 jq -r '.plays[].tasks[] | .task.name as $t | .hosts | to_entries[] | select(.value.changed == true) | "- changed: \(.key) \($t)"' "$out" || true
               fi
             } > "$RUNNER_TEMP/report-$e.md"
-            if [ "$CONVERGE" = "true" ] && [ "$result" = "drift" ]; then
-              tf_rc=-1; ans_rc=-1
-              if [ "$plan_rc" -eq 2 ]; then
-                tf_rc=0
-                terraform -chdir="$wt/terraform/envs/$e" apply -input=false -no-color -auto-approve -lock-timeout=5m || tf_rc=$?
-              fi
-              if [ "$tf_rc" -le 0 ]; then
-                ans_rc=0
-                (cd "$wt/ansible" && ansible-playbook -i "inventories/$e" site.yml --diff --vault-id "gitops16@$GITHUB_WORKSPACE/.github/scripts/vault-pass-client.sh") || ans_rc=$?
-              fi
-              echo "CONVERGE $e ref=$ref terraform_apply_exit_code=$tf_rc ansible_exit_code=$ans_rc"
-              if [ "$tf_rc" -gt 0 ] || [ "$ans_rc" -gt 0 ]; then
-                failed=1
-              fi
+          done
+          for e in dev stg prod; do
+            if [ "$CONVERGE" != "true" ] || [ "$(cat "$RUNNER_TEMP/result-$e")" != "drift" ]; then
+              continue
             fi
-            git worktree remove --force "$wt" 2> /dev/null || true
+            echo "== converge $e"
+            wt="$RUNNER_TEMP/detect-$e"
+            ref=$(git -C "$wt" rev-parse HEAD)
+            tf_rc=-1; ans_rc=-1
+            if [ "$(cat "$RUNNER_TEMP/plan_rc-$e")" -eq 2 ]; then
+              tf_rc=0
+              sha256sum "$RUNNER_TEMP/tfplan-$e"
+              terraform -chdir="$wt/terraform/envs/$e" apply -input=false -no-color -lock-timeout=5m "$RUNNER_TEMP/tfplan-$e" || tf_rc=$?
+            fi
+            if [ "$tf_rc" -le 0 ]; then
+              ans_rc=0
+              (cd "$wt/ansible" && ansible-playbook -i "inventories/$e" site.yml --diff --vault-id "gitops16@$GITHUB_WORKSPACE/.github/scripts/vault-pass-client.sh") || ans_rc=$?
+            fi
+            echo "CONVERGE $e ref=$ref terraform_apply_exit_code=$tf_rc ansible_exit_code=$ans_rc"
+            if [ "$tf_rc" -gt 0 ] || [ "$ans_rc" -gt 0 ]; then
+              failed=1
+            fi
+          done
+          for e in dev stg prod; do
+            git worktree remove --force "$RUNNER_TEMP/detect-$e" 2> /dev/null || true
           done
           exit $failed
       - name: Report to issues
@@ -144,5 +154,5 @@ jobs:
       - name: Clean up
         if: always()
         run: |
-          rm -rf "$RUNNER_TEMP/keys" "$RUNNER_TEMP"/check-*.json "$RUNNER_TEMP"/result-* "$RUNNER_TEMP"/report-*.md
+          rm -rf "$RUNNER_TEMP/keys" "$RUNNER_TEMP"/check-*.json "$RUNNER_TEMP"/result-* "$RUNNER_TEMP"/report-*.md "$RUNNER_TEMP"/tfplan-* "$RUNNER_TEMP"/plan_rc-*
           git worktree prune
```

変えた内容は、次のとおりです。

* 検知のループでは、`plan`に`-out`を付けて、環境ごとのplanを`$RUNNER_TEMP/tfplan-<環境>`に保存し、`plan`の終了コードもファイルに残す。取り出したコードは、まだ片付けない
* 収束のループでは、結果が差分あり（`drift`）の環境だけを対象にする。`plan`に差分があれば、保存したplanのハッシュ値を表示してから、そのplanを適用する。`-auto-approve`は付けない。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション3で確かめたとおり、保存したplanを渡した`apply`は、確認を求めずに、保存した計画のとおりに実行するため
* 3環境の検知をすべて終えてから収束するため、検知と収束の間に、ほかの環境の検知の時間が入る
* 保存したplanには機密の値が含まれうるため、本人だけが読める権限で作り、ステップ「Clean up」で消す

この変更をプルリクエスト（PR#103）にし、確認の実行（「GitOps Pipeline」の実行#178）で`changes`ジョブだけが動いたことを確かめて、マージしました（マージコミット`d538e49`、「GitOps Pipeline」の実行#179）。

### ■ 検証内容：devとstgにドリフトを作る

devには、Terraformで検出できるドリフトを作ります。dev-node1の再起動の方針（`restart`）を、`docker update`で変えます。stgには、Ansibleで検出できるドリフトを作ります。prodには何もしません。

**実行コマンド**

```plaintext
docker inspect -f '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}}' dev-node1
docker update --restart always dev-node1
docker inspect -f '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}}' dev-node1
terraform -chdir=terraform/envs/dev plan -input=false -no-color 2>&1 | grep -E '^  # |restart|forces replacement|^Plan:|No changes'
docker exec stg-node1 cat /etc/drift-check-target.conf
docker exec stg-node1 sed -i 's/ansible-drift-check/manual-edit/' /etc/drift-check-target.conf
docker exec stg-node1 cat /etc/drift-check-target.conf
```

**▼ 実行結果**

```plaintext
/dev-node1 restart=no
dev-node1
/dev-node1 restart=always
  # module.lab_env.docker_container.targets["dev-node1"] will be updated in-place
      ~ restart                                     = "always" -> "no"
Plan: 0 to add, 1 to change, 0 to destroy.
monitored_by=ansible-drift-check
monitored_by=manual-edit
```

devの`restart`の変更は、作り直しではなく、その場の更新（`update in-place`）として`plan`に現れました。

### ■ 検証内容：保存したplanで自動収束させる

「Drift Detect」を、`compare_with`を`last-applied`、`converge`を有効にして起動しました（「Drift Detect」の実行#21）。

**▼ 実行結果**（「Drift Detect」の実行#21、`detect`ジョブのステップ「Detect drift」と「Report to issues」から抜粋。時刻はUTC）

```plaintext
04:07:32.0578960Z == dev
04:07:32.2903515Z compare_with=last-applied ref=0358b1a4362d4873a56aad5d96c08fa4cca453ce
（途中省略：Refreshing state...によるリソース一覧の出力）
04:07:44.8269549Z   # module.lab_env.docker_container.targets["dev-node1"] will be updated in-place
（途中省略）
04:07:44.8292545Z       ~ restart                                     = "always" -> "no"
（途中省略）
04:07:44.8371600Z Plan: 0 to add, 1 to change, 0 to destroy.
（途中省略）
04:07:44.8383456Z Saved the plan to: /home/control/actions-runner/_work/_temp/tfplan-dev
（途中省略）
04:08:03.1972073Z RESULT dev=drift plan_exit_code=2 check_exit_code=0 changed=0 failed_hosts=0
04:08:03.2886972Z == stg
（途中省略：devと同じ形の表示。planは差分なし）
04:08:32.8852829Z changed: stg-node1 common_setup : ドリフト検知の実演用設定ファイルを配置
04:08:32.8877259Z RESULT stg=drift plan_exit_code=0 check_exit_code=0 changed=1 failed_hosts=0
04:08:32.9812176Z == prod
（途中省略：devと同じ形の表示。planは差分なし）
04:09:07.6930879Z RESULT prod=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
04:09:07.7678768Z == converge dev
04:09:07.8108747Z 7e5d25451a6c8f36830b02459d61818d71290873148199a96ca46195194c1f88  /home/control/actions-runner/_work/_temp/tfplan-dev
04:09:09.6802555Z module.lab_env.docker_container.targets["dev-node1"]: Modifying... [id=c19b56ffe13230439585b6cb292c6fae7dcab9331d8c49b8757a718ec304bc18]
04:09:09.8930965Z module.lab_env.docker_container.targets["dev-node1"]: Modifications complete after 0s [id=c19b56ffe13230439585b6cb292c6fae7dcab9331d8c49b8757a718ec304bc18]
04:09:09.9247634Z Apply complete! Resources: 0 added, 1 changed, 0 destroyed.
（途中省略：Outputsの表示、Ansibleの本実行の表示）
04:09:24.8304455Z dev-node1                  : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
04:09:25.0253207Z CONVERGE dev ref=0358b1a4362d4873a56aad5d96c08fa4cca453ce terraform_apply_exit_code=0 ansible_exit_code=0
04:09:25.0319205Z == converge stg
（途中省略：PLAYの表示）
04:09:33.7140168Z --- before: /etc/drift-check-target.conf
04:09:33.7142074Z +++ after: /etc/drift-check-target.conf
04:09:33.7143193Z @@ -1 +1 @@
04:09:33.7144044Z -monitored_by=manual-edit
04:09:33.7147180Z +monitored_by=ansible-drift-check
（途中省略：残りのタスクはok）
04:09:43.7231344Z stg-node1                  : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
04:09:43.8936981Z CONVERGE stg ref=0358b1a4362d4873a56aad5d96c08fa4cca453ce terraform_apply_exit_code=-1 ansible_exit_code=0
（ステップ「Report to issues」）
04:09:45.7664770Z issue #104 created: [drift-detect] dev
04:09:47.7192063Z issue #105 created: [drift-detect] stg
04:09:48.6794117Z no open issue: [drift-detect] prod
```

手元で、実環境を確かめます。

**実行コマンド**

```plaintext
docker inspect -f '{{.Name}} id={{printf "%.12s" .Id}} restart={{.HostConfig.RestartPolicy.Name}}' dev-node1
docker exec stg-node1 cat /etc/drift-check-target.conf
for e in dev stg prod; do terraform -chdir=terraform/envs/$e plan -input=false -detailed-exitcode > /dev/null 2>&1; echo "$e plan_exit_code=$?"; done
```

**▼ 実行結果**

```plaintext
/dev-node1 id=c19b56ffe132 restart=no
monitored_by=ansible-drift-check
dev plan_exit_code=0
stg plan_exit_code=0
prod plan_exit_code=0
```

### ■ 結果

3つの環境の扱いを並べると、次のとおりです。

|環境|検知の結果|Terraform|Ansible|
|---|---|---|---|
|dev|差分あり（`plan_exit_code=2`）|検知で保存したplanを適用し、`restart`を`no`に戻した|本実行した（変更なし）|
|stg|差分あり（`changed=1`）|`plan`が差分なしのため動いていない（`terraform_apply_exit_code=-1`）|本実行し、ファイルを戻した|
|prod|差分なし|収束の対象にならず、何もしていない|何もしていない|

devの収束で適用されたのは、検知のときに`Saved the plan to`と表示して保存したplanそのものです。適用の直前にハッシュ値を表示し、`restart`の`"always" -> "no"`だけが、その場の更新として適用されました。コンテナのIDは`c19b56ffe132`のままで、作り直されていません。

Ansibleの本実行は、差分ありと判定したdevとstgでだけ行われました。prodには、確認モードの後に、何の実行も届いていません。devは、Ansibleの差分がなかった（`changed=0`）環境ですが、**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** と同じく、Terraformが動いた環境ではAnsibleも動かしています。

### ■ 検証内容：検知から収束までの間にtfstateが変わったとき

検知でplanを保存した後、収束でそのplanを適用する前に、パイプラインの外からdevのtfstateを変えます。**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** で整理したとおり、手元からの`terraform apply`は、パイプラインの同時実行のグループでは止められません。

devに、もう一度同じドリフトを作り、devの`terraform_data`のIDを記録しておきます。

**実行コマンド**

```plaintext
docker update --restart always dev-node1
docker inspect -f '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}}' dev-node1
terraform -chdir=terraform/envs/dev state show -no-color module.lab_env.terraform_data.gitops18_pending | grep -E '^ +id '
ls -l /home/control/actions-runner/_work/_temp/tfplan-dev; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
dev-node1
/dev-node1 restart=always
    id     = "e328167a-7501-2e52-7d49-c57e2436ba05"
ls: cannot access '/home/control/actions-runner/_work/_temp/tfplan-dev': No such file or directory
exit_code=2
```

手元で、ランナーがdevのplanを保存するのを待ち、保存された直後に、devの`terraform_data`だけを作り直す`apply`を実行するコマンドを動かしておきます。ランナーは同じホストで動いているため、planのファイルが作られたことを、手元から確かめられます。`-target`で対象を`terraform_data`に絞り、`restart`のドリフトは戻しません。

**実行コマンド**

```plaintext
while [ ! -f /home/control/actions-runner/_work/_temp/tfplan-dev ]; do sleep 1; done; date -u '+%H:%M:%S'; terraform -chdir=terraform/envs/dev apply -input=false -no-color -auto-approve -lock-timeout=60s -target=module.lab_env.terraform_data.gitops18_pending -replace=module.lab_env.terraform_data.gitops18_pending 2>&1 | grep -E 'Destroy|Creat|Apply complete|Warning|Error'; date -u '+%H:%M:%S'
```

このコマンドを動かしたまま、「Drift Detect」を、`compare_with`を`last-applied`、`converge`を有効にして起動しました（「Drift Detect」の実行#23）。

**▼ 実行結果**（「Drift Detect」の実行#23、`detect`ジョブのステップ「Detect drift」と「Report to issues」から抜粋。時刻はUTC）

```plaintext
04:40:03.5209117Z == dev
04:40:03.7808161Z compare_with=last-applied ref=0358b1a4362d4873a56aad5d96c08fa4cca453ce
04:40:12.1094033Z module.lab_env.terraform_data.gitops18_pending: Refreshing state... [id=e328167a-7501-2e52-7d49-c57e2436ba05]
（途中省略：Refreshing state...によるリソース一覧の出力）
04:40:14.6162666Z   # module.lab_env.docker_container.targets["dev-node1"] will be updated in-place
（途中省略）
04:40:14.6185940Z       ~ restart                                     = "always" -> "no"
（途中省略）
04:40:14.6420403Z Saved the plan to: /home/control/actions-runner/_work/_temp/tfplan-dev
（途中省略）
04:40:33.8216427Z RESULT dev=drift plan_exit_code=2 check_exit_code=0 changed=0 failed_hosts=0
04:40:33.9151718Z == stg
（途中省略）
04:41:03.5748748Z RESULT stg=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
04:41:03.6616138Z == prod
（途中省略）
04:41:40.8423638Z RESULT prod=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
04:41:40.9533778Z == converge dev
04:41:40.9829745Z 858a1cacb988827cc9ed679ac99b655bc67487ae3dd56e2dac8cd149016ffb78  /home/control/actions-runner/_work/_temp/tfplan-dev

04:41:42.1139370Z Error: Saved plan is stale

04:41:42.1195677Z The given plan file can no longer be applied because the state was changed by
04:41:42.1197741Z another operation after the plan was created.
04:41:42.1332579Z CONVERGE dev ref=0358b1a4362d4873a56aad5d96c08fa4cca453ce terraform_apply_exit_code=1 ansible_exit_code=-1
04:41:42.2062918Z ##[error]Process completed with exit code 1.
（ステップ「Report to issues」）
04:41:44.5942735Z issue #104 updated: [drift-detect] dev
04:41:45.5747108Z no open issue: [drift-detect] stg
04:41:46.5651467Z no open issue: [drift-detect] prod
```

手元で、実行の後の状態を確かめます。

**実行コマンド**

```plaintext
docker inspect -f '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}}' dev-node1
terraform -chdir=terraform/envs/dev state show -no-color module.lab_env.terraform_data.gitops18_pending | grep -E '^ +id '
terraform -chdir=terraform/envs/dev plan -input=false -no-color 2>&1 | grep -E '^  # |restart|^Plan:|No changes'
psql "$PG_CONN_STR" -X -c "SELECT locktype, objid, granted FROM pg_locks WHERE locktype = 'advisory';"
```

**▼ 実行結果**

```plaintext
/dev-node1 restart=always
    id     = "6dcdaa9d-920a-31ff-b958-e92e9a604550"
  # module.lab_env.docker_container.targets["dev-node1"] will be updated in-place
      ~ restart                                     = "always" -> "no"
Plan: 0 to add, 1 to change, 0 to destroy.
 locktype | objid | granted
----------+-------+---------
(0 rows)
```

### ■ 結果

時刻を並べると、次のとおりです（UTC）。

|時刻|出来事|
|---|---|
|04:40:12|devの検知の`plan`が、`terraform_data`をID`e328167a...`として読む|
|04:40:14|devの検知の`plan`が、planを保存する|
|（この間）|手元の`apply`が、`terraform_data`を作り直し、devのtfstateを書き換える|
|04:41:40|devの収束が始まり、保存したplanのハッシュ値を表示する|
|04:41:42|保存したplanが`Saved plan is stale`で拒否される|

実行の後の`terraform_data`のIDは`6dcdaa9d...`で、検知が読んだ`e328167a...`から変わっています。検知でplanを保存した後に、手元の`apply`がdevのtfstateを書き換えたため、収束で保存したplanを適用しようとしたところで、適用そのものが拒否されました。

拒否されたため、Terraformの`apply`の終了コードは1で、Ansibleは本実行されず（`ansible_exit_code=-1`）、`detect`ジョブは失敗しています。devの`restart`は`always`のまま残り、Issue#104は、devの差分ありとして開いたまま本文が書き換えられました。自動収束は、前提が変わったまま適用することはせず、止まって、ドリフトをIssueに残したことになります。

**[セクション2](#2-mainへ収束させると承認ゲートを迂回する)** の形のように、収束の時点で`plan`を計算し直していれば、手元の`apply`の後の状態に対して計画が作られ、そのまま適用されていたはずです（この形では確かめていません）。保存したplanを適用する形にしたことで、自動収束が適用するのは、検知で見つけて保存した計画だけになり、その計画の前提が崩れたときは、何も適用せずに止まるようになりました。

残ったドリフトは、「Drift Detect」をもう一度、`converge`を有効にして起動し（「Drift Detect」の実行#24）、新しく保存したplanで戻しました。続けて、`converge`を無効にして起動し（「Drift Detect」の実行#25）、3環境とも差分なしで、Issue#104が閉じられたことを確かめています。

### 保存したplanが守るものと、守らないもの

保存したplanが止めるのは、計画を作った後にtfstateが変わった場合です。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション3で確かめたとおり、設定が変わっただけでは止まりません。この回の自動収束では、比べるコードは最後に適用したコミットから取り出した固定のものなので、収束の途中で設定が変わることはありません。

一方で、Ansibleの側には、この保証がありません。収束の本実行は、その時点の実環境に対して、Playbookを最初から実行します。確認モードで見た差分と、本実行で変わる内容が同じであることは、**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション4で確かめたとおり、仕組みとしては保証されません。Ansibleの側で自動収束が絞れるのは、本実行する環境を、差分ありと判定した環境に限ることまでです。

ここまでで、自動収束は、承認済みの状態に向けて、検知で見つけた差分だけを戻す形になりました。ただし、検知で見つけた差分であれば、何でも戻してよいとは限りません。次のセクションでは、自動で戻してよい変更と、人に判断を返すべき変更を分けます。

---

[↑ 目次に戻る](#-目次)

---

## 4. 自動で戻す変更と人に返す変更

検知で見つけた差分のうち、自動で戻してよい変更と、人に判断を返すべき変更を分け、判定の仕組みを自動収束に組み込みます。

### 戻すだけで済む変更と、戻すと失うものがある変更

**[セクション3](#3-検知した内容だけを適用する)** までの自動収束は、差分ありと判定した環境を、内容を問わず戻していました。ところが、ドリフトを戻す変更の中には、戻すことで別のものを失う変更があります。

|変更の種類|自動収束で戻すと起きること|
|---|---|
|属性の更新（その場の更新）|ずれた属性が、最後に適用したコミットの値に戻る。リソースは残る|
|作り直し（削除してから作成）|リソースが新しく作られ、中に入れていた設定やデータは消える。**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** で確かめたとおり、Ansibleで入れた設定は入れ直しになる|
|削除|リソースがなくなる|
|作成|リソースが新しく作られる|

作成には、注意が必要です。承認ゲートを通る通常の変更では、作成は新しく足したリソースのためのものです。一方、自動収束は、すでに適用したコミットのコードで実環境と比べています。そこで作成が出るのは、適用済みのリソースが実環境から消えたときです。つまり、自動収束の作成は、消えたものの作り直しを意味します。

**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** の判定（`plan-policy.sh`）は、承認ゲートの入口で使うために作ったもので、`delete`を含む変更を止め、作成は通します。自動収束では、この判定に加えて、作成を含む変更も人に返します。**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** では、devに限って作り直しと削除を通していました。人が起動する承認ゲートでは、起動した人がplanを見ているためです。自動収束は人の承認を経ないため、環境を問わず人に返します。

**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** の検知失敗も、収束の対象にしません。検知が失敗した環境では、何が差分なのかが分からないためです。

### ■ 検証内容：保存したplanを判定してから適用する

収束のループの、Terraformの`apply`の前に、判定を加えました。

**▼ 実行結果**（`git diff`、「Drift Detect」の変更）

```plaintext
@@ -117,8 +117,20 @@ jobs:
             ref=$(git -C "$wt" rev-parse HEAD)
             tf_rc=-1; ans_rc=-1
             if [ "$(cat "$RUNNER_TEMP/plan_rc-$e")" -eq 2 ]; then
-              tf_rc=0
               sha256sum "$RUNNER_TEMP/tfplan-$e"
+              (umask 077; terraform -chdir="$wt/terraform/envs/$e" show -json "$RUNNER_TEMP/tfplan-$e" > "$RUNNER_TEMP/tfplan-$e.json")
+              policy_rc=0
+              "$GITHUB_WORKSPACE"/.github/scripts/plan-policy.sh < "$RUNNER_TEMP/tfplan-$e.json" || policy_rc=$?
+              creates=$(jq '[.resource_changes[]? | select(.change.actions | index("create"))] | length' "$RUNNER_TEMP/tfplan-$e.json") || creates=-1
+              if [ "$policy_rc" -ne 0 ] || [ "$creates" -ne 0 ]; then
+                echo "HOLD $e policy_exit_code=$policy_rc creates=$creates"
+                {
+                  echo
+                  echo "- 自動収束: 削除・作り直し・作成を含むため、人の判断に返した（policy_exit_code=$policy_rc creates=$creates）"
+                } >> "$RUNNER_TEMP/report-$e.md"
+                continue
+              fi
+              tf_rc=0
               terraform -chdir="$wt/terraform/envs/$e" apply -input=false -no-color -lock-timeout=5m "$RUNNER_TEMP/tfplan-$e" || tf_rc=$?
             fi
             if [ "$tf_rc" -le 0 ]; then
```

加えた内容は、次のとおりです。

* 検知で保存したplanをJSONに変換し、**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** の`plan-policy.sh`にかける。判定に使うのは、適用しようとしているplanそのもの
* あわせて、`create`を含む変更の数を数える
* どちらかに当たれば、`HOLD`の行を表示し、Issueの本文に理由を書き足して、その環境の収束を飛ばす。TerraformもAnsibleも動かさない
* JSONは本人だけが読める権限で作り、ステップ「Clean up」で保存したplanと一緒に消す

この変更をプルリクエスト（PR#106）にし、確認の実行（「GitOps Pipeline」の実行#180）で`changes`ジョブだけが動いたことを確かめて、マージしました（マージコミット`78be5b4`、「GitOps Pipeline」の実行#181）。

### ■ 検証内容：性質の違う3つのドリフトを作る

3つの環境に、性質の違うドリフトを1つずつ作ります。

|環境|作るドリフト|作り方|
|---|---|---|
|dev|作り直しが必要なドリフト|dev-node1が使っているイメージの名前を外す|
|stg|検知失敗|stg-node1の`authorized_keys`の名前を変え、Ansibleが接続できないようにする|
|prod|属性だけのドリフト|target-node1の再起動の方針（`restart`）を変える|

devとprodのドリフトを作り、手元の`plan`で差分の形を確かめます。この検証環境では、3つの環境のイメージの名前が同じイメージを指しているため、`docker rmi`は名前を外すだけで、イメージそのものは消えません。

**実行コマンド**

```plaintext
docker image ls --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep ansible-target:ubuntu22.04
docker rmi ansible-target:ubuntu22.04-dev
docker image ls --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep ansible-target:ubuntu22.04
terraform -chdir=terraform/envs/dev plan -input=false -no-color 2>&1 | grep -E '^  # |forces replacement|^Plan:|No changes'
docker update --restart always target-node1
docker inspect -f '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}}' target-node1
terraform -chdir=terraform/envs/prod plan -input=false -no-color 2>&1 | grep -E '^  # |restart|forces replacement|^Plan:|No changes'
```

**▼ 実行結果**

```plaintext
ansible-target:ubuntu22.04 580e369fb41b
ansible-target:ubuntu22.04-dev 580e369fb41b
ansible-target:ubuntu22.04-stg 580e369fb41b
Untagged: ansible-target:ubuntu22.04-dev
ansible-target:ubuntu22.04 580e369fb41b
ansible-target:ubuntu22.04-stg 580e369fb41b
  # module.lab_env.docker_image.this has been deleted
  # module.lab_env.docker_container.targets["dev-node1"] must be replaced
      ~ image                                       = "sha256:580e369fb41b08cc58beded6d6ab0ee567a68bf62d82c8c87eeb7c1bb2aa88b6" -> (known after apply) # forces replacement
  # module.lab_env.docker_image.this will be created
Plan: 2 to add, 0 to change, 1 to destroy.
target-node1
/target-node1 restart=always
  # module.lab_env.docker_container.targets["target-node1"] will be updated in-place
      ~ restart                                     = "always" -> "no"
Plan: 0 to add, 1 to change, 0 to destroy.
```

devは、イメージの名前が外れただけで、`plan`は「イメージの作成」と「コンテナの作り直し」になりました。イメージの中身は同じでも、Terraformから見るとイメージのリソースは消えており、作り直すイメージのIDは作るまで分からない（`known after apply`）ため、コンテナまで作り直しになります。prodは、その場の更新だけです。

続けて、stgで接続できない状態を作ります。コンテナには触れません。

**実行コマンド**

```plaintext
docker exec stg-node1 mv /home/ansible/.ssh/authorized_keys /home/ansible/.ssh/authorized_keys.gitops19
cd ansible
ansible -i inventories/stg all -m ping --vault-id "gitops16@$HOME/.config/ansible-vault/gitops16-vault-pass" 2>/dev/null | grep -E 'UNREACHABLE|Permission denied'
cd ..
```

**▼ 実行結果**

```plaintext
stg-node1 | UNREACHABLE! => {
（途中省略）
ansible@172.21.0.2: Permission denied (publickey,password).",
```

### ■ 検証内容：自動収束を実行する

「Drift Detect」を、`compare_with`を`last-applied`、`converge`を有効にして起動しました（「Drift Detect」の実行#26）。

**▼ 実行結果**（「Drift Detect」の実行#26、`detect`ジョブのステップ「Detect drift」と「Report to issues」から抜粋。時刻はUTC）

```plaintext
07:04:58.6135500Z == dev
（途中省略：Refreshing state...によるリソース一覧の出力）
07:05:04.8090732Z   # module.lab_env.docker_image.this has been deleted
（途中省略）
07:05:04.8218974Z   # module.lab_env.docker_container.targets["dev-node1"] must be replaced
（途中省略）
07:05:04.8249188Z       ~ image                                       = "sha256:580e369fb41b08cc58beded6d6ab0ee567a68bf62d82c8c87eeb7c1bb2aa88b6" -> (known after apply) # forces replacement
（途中省略）
07:05:04.8287830Z   # module.lab_env.docker_image.this will be created
（途中省略）
07:05:04.8304115Z Plan: 2 to add, 0 to change, 1 to destroy.
（途中省略）
07:05:04.8312723Z Saved the plan to: /home/control/actions-runner/_work/_temp/tfplan-dev
（途中省略）
07:05:11.9750834Z RESULT dev=drift plan_exit_code=2 check_exit_code=0 changed=0 failed_hosts=0
07:05:12.0323901Z == stg
（途中省略：planは差分なし）
07:05:19.7960104Z {"stg-node1":{"changed":0,"failures":0,"ignored":0,"ok":0,"rescued":0,"skipped":0,"unreachable":1}}
07:05:19.8199510Z RESULT stg=detect_failed plan_exit_code=0 check_exit_code=4 changed=0 failed_hosts=1
07:05:19.8631401Z == prod
（途中省略）
07:05:25.3864947Z   # module.lab_env.docker_container.targets["target-node1"] will be updated in-place
（途中省略）
07:05:25.3874364Z       ~ restart                                     = "always" -> "no"
（途中省略）
07:05:25.3880082Z Plan: 0 to add, 1 to change, 0 to destroy.
（途中省略）
07:05:37.1439096Z RESULT prod=drift plan_exit_code=2 check_exit_code=0 changed=0 failed_hosts=0
07:05:37.1742555Z == converge dev
07:05:37.1929099Z 8d2300e5d82690c9fdabcb5c1f41dbf45585de9c507f05d07df1d8f239bb147d  /home/control/actions-runner/_work/_temp/tfplan-dev
07:05:37.9292251Z PASS  module.lab_env.docker_image.this actions=create
07:05:37.9826594Z BLOCK module.lab_env.docker_container.targets["dev-node1"] actions=delete,create reason=replace_because_cannot_update
07:05:37.9922906Z policy: blocked (1)
07:05:38.0290711Z HOLD dev policy_exit_code=1 creates=2
07:05:38.0345046Z == converge prod
07:05:38.0470843Z ebe8e3fae37c627f138c799022ca9d8575d30679b4457dcb6e3939fa748f8bed  /home/control/actions-runner/_work/_temp/tfplan-prod
07:05:38.9483137Z PASS  module.lab_env.docker_container.targets["target-node1"] actions=update
07:05:38.9906510Z policy: pass
07:05:39.9201315Z module.lab_env.docker_container.targets["target-node1"]: Modifying... [id=ade38668fb28bd7dc2cea7e840fa4daa000599245f26deaf5c532c8868c45d10]
07:05:40.0012489Z module.lab_env.docker_container.targets["target-node1"]: Modifications complete after 0s [id=ade38668fb28bd7dc2cea7e840fa4daa000599245f26deaf5c532c8868c45d10]
07:05:40.0498182Z Apply complete! Resources: 0 added, 1 changed, 0 destroyed.
（途中省略：Outputsの表示、Ansibleの本実行の表示。3台ともchanged=0）
07:05:50.8720702Z CONVERGE prod ref=0358b1a4362d4873a56aad5d96c08fa4cca453ce terraform_apply_exit_code=0 ansible_exit_code=0
07:05:50.8959508Z ##[error]Process completed with exit code 1.
（ステップ「Report to issues」）
07:05:52.6326469Z issue #107 created: [drift-detect] dev
07:05:54.2366162Z issue #108 created: [drift-detect] stg
07:05:55.7484280Z issue #109 created: [drift-detect] prod
```

devのIssue（Issue#107）の本文は、次のとおりです。

**▼ 実行結果**（Issue#107の本文）

```plaintext
- 結果: drift
- 比べたコミット: 0358b1a4362d4873a56aad5d96c08fa4cca453ce
- plan_exit_code=2 check_exit_code=0 changed=0 failed_hosts=0
- 実行: https://github.com/juehara-crypto/ansible-terraform-ci-lab/actions/runs/40833123624
- 時刻: 2026-10-29T07:05:11Z

- 自動収束: 削除・作り直し・作成を含むため、人の判断に返した（policy_exit_code=1 creates=2）
```

手元で、実環境を確かめます。

**実行コマンド**

```plaintext
docker inspect -f '{{.Name}} id={{printf "%.12s" .Id}} restart={{.HostConfig.RestartPolicy.Name}}' dev-node1 target-node1
for e in dev stg prod; do terraform -chdir=terraform/envs/$e plan -input=false -detailed-exitcode > /dev/null 2>&1; echo "$e plan_exit_code=$?"; done
```

**▼ 実行結果**

```plaintext
/dev-node1 id=c19b56ffe132 restart=no
/target-node1 id=ade38668fb28 restart=no
dev plan_exit_code=2
stg plan_exit_code=0
prod plan_exit_code=0
```

### ■ 結果

3つの環境の扱いを並べると、次のとおりです。

|環境|検知の結果|判定|自動収束|
|---|---|---|---|
|dev|差分あり（`plan_exit_code=2`）|コンテナの作り直しを`BLOCK`（`policy_exit_code=1`）、作成を2件含む（`creates=2`）|人に返した。TerraformもAnsibleも動いていない|
|stg|検知失敗（`check_exit_code=4`、`unreachable=1`）|判定まで進まない|収束の対象にならなかった|
|prod|差分あり（`plan_exit_code=2`）|`update`だけで`policy: pass`|保存したplanを適用し、`restart`を`no`に戻した|

devは、コンテナのIDが`c19b56ffe132`のままで、作り直されていません。実環境の差分（`plan_exit_code=2`）も残ったままです。自動収束は、作り直しが必要なドリフトには手を出さず、理由をIssueに書き足して、人の判断に返しました。イメージの作成は`plan-policy.sh`を通っています（`PASS ... actions=create`）。それでも、この回で加えた作成の数の判定で、作成を含む変更と判定されたため、イメージだけを先に作ることもしていません。作り直しを決めるのは、Ansibleで入れた設定が消えることを承知したうえでの、人の判断です。

stgは、検知の段階で失敗し、収束の対象になりませんでした。stgの`detect`ジョブの失敗は、ジョブ全体の失敗として残り、stgのIssue（Issue#108）も作られています。

prodは、属性だけのドリフトとして、自動で戻りました。

### 検知が失敗した環境では、本物のドリフトも見えない

後片付けで、stgの`authorized_keys`の名前を戻してから確認モードを実行すると、stg-node1に差分が1つ見つかりました。

**▼ 実行結果**（`ansible-playbook -i inventories/stg site.yml --check --diff`から抜粋）

```plaintext
TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] ****************************
--- before: /etc/drift-check-target.conf
+++ after: /etc/drift-check-target.conf
@@ -1 +1 @@
-monitored_by=manual-edit
+monitored_by=ansible-drift-check

changed: [stg-node1]
```

stg-node1には、自動収束を実行した時点で、**[セクション3](#3-検知した内容だけを適用する)** と同じ書き換えが残っていました。「Drift Detect」の実行#26では、stgは接続の段階で失敗したため、このドリフトは検知の結果にも、Issueの本文にも現れていません。検知失敗は「差分がない」ことでも「差分がある」ことでもなく、「分からない」ことです。だからこそ、自動収束の対象にせず、人に返す必要があります。

このドリフトは、作り直しも削除も含まないファイルの書き換えなので、「Drift Detect」を`converge`を有効にして起動して戻しました（「Drift Detect」の実行#27）。devのイメージの名前は`docker tag`で付け直し、続けて`converge`を無効にして起動し（「Drift Detect」の実行#28）、3環境とも差分なしで、Issue#107〜#109が閉じられたことを確かめています。

**▼ 実行結果**（「Drift Detect」の実行#28、`detect`ジョブから抜粋）

```plaintext
RESULT dev=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
RESULT stg=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
RESULT prod=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
（途中省略）
no open issue: [drift-detect] dev
issue #108 closed: [drift-detect] stg
no open issue: [drift-detect] prod
```

自動で戻してよいのは、戻すだけで何も失わない、属性の更新です。作り直し・削除・作成を含む変更と検知失敗は、人に返します。ここまでで、自動収束が何を戻すかが決まりました。次のセクションでは、戻す順序と、戻す前に確かめる条件を整えます。

---

[↑ 目次に戻る](#-目次)

---

## 5. 収束の順序と前提条件

自動収束が戻す順序と、戻す前に確かめる条件を、承認ゲートを通る適用と同じにそろえます。

### 収束の順序はTerraform→Ansible

**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** では、TerraformとAnsibleのパイプラインを、Terraform→Ansibleの順に固定しました。Ansibleが設定を入れる先は、Terraformが作ったリソースだからです。自動収束も同じ順序で動きます。**[セクション3](#3-検知した内容だけを適用する)** の検証で、次の2つを確かめています。

* devでは、保存したplanの適用が成功した（`terraform_apply_exit_code=0`）後に、Ansibleを本実行した
* 検知の後にtfstateが変わったときは、保存したplanが`Saved plan is stale`で拒否され（`terraform_apply_exit_code=1`）、Ansibleは本実行されなかった（`ansible_exit_code=-1`）

Terraformの側で止まった環境に、Ansibleだけを流すことはありません。

### 前提条件1：比べたコミットがガードレールを通過していること

**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** と **[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** では、「GitOps Apply」の`verify`ジョブで、適用するコミットに付いたチェックの結果（ansible-lint、Molecule、Terraformの静的なチェック）をGitHubのAPIで読み、`success`以外なら止める形にしました。チェックが失敗したコミットは、承認ゲートを通れません。

そのため、パイプラインの中で記録された最後に適用したコミットは、ガードレールを通過しているはずです。ところが、記録を残しているのは`gitops.applied`という表で、**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** の`applied.sh`を通せば、パイプラインの外からでも1行足せます。自動収束は、記録に書かれたコミットのコードを、人の承認なしに本実行します。記録が正しいことを、そのまま信じて本実行するのは避けたいところです。そこで、自動収束でも、本実行の前に比べたコミットのチェックの結果を確かめます。

### ■ 検証内容：収束の前にガードレールの結果を確かめる

「Drift Detect」の収束のループの先頭に、確認を加えました。権限に`checks: read`を足し、ステップ「Detect drift」に`GH_TOKEN`を渡しています。

**▼ 実行結果**（`git diff`、「Drift Detect」の変更）

```plaintext
@@ -24,6 +24,7 @@ concurrency:
 permissions:
   contents: read
   issues: write
+  checks: read

 jobs:
   detect:
@@ -57,6 +58,7 @@ jobs:
         env:
           COMPARE_WITH: ${{ inputs.compare_with || 'last-applied' }}
           CONVERGE: ${{ inputs.converge == true }}
+          GH_TOKEN: ${{ github.token }}
           PG_CONN_STR: ${{ secrets.PG_CONN_STR }}
           TF_VAR_deploy_user_password: ${{ secrets.TF_VAR_DEPLOY_USER_PASSWORD }}
           ANSIBLE_VAULT_PASSWORD_GITOPS16: ${{ secrets.ANSIBLE_VAULT_PASSWORD_GITOPS16 }}
@@ -116,6 +118,24 @@ jobs:
             wt="$RUNNER_TEMP/detect-$e"
             ref=$(git -C "$wt" rev-parse HEAD)
             tf_rc=-1; ans_rc=-1
+            guard_ng=""
+            for name in terraform-static ansible-lint molecule; do
+              conclusion=$(curl -fsSL -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
+                "https://api.github.com/repos/$GITHUB_REPOSITORY/commits/$ref/check-runs?check_name=$name" \
+                | jq -r '[.check_runs[] | select(.app.slug == "github-actions")] | sort_by(.started_at) | last | .conclusion // "missing"') || conclusion=error
+              echo "guardrail $e $name: $conclusion"
+              if [ "$conclusion" != "success" ] && [ "$conclusion" != "skipped" ]; then
+                guard_ng="$guard_ng $name=$conclusion"
+              fi
+            done
+            if [ -n "$guard_ng" ]; then
+              echo "HOLD $e guardrail:$guard_ng"
+              {
+                echo
+                echo "- 自動収束: 比べたコミットがガードレールを通過していないため、人の判断に返した（$guard_ng ）"
+              } >> "$RUNNER_TEMP/report-$e.md"
+              continue
+            fi
             if [ "$(cat "$RUNNER_TEMP/plan_rc-$e")" -eq 2 ]; then
               sha256sum "$RUNNER_TEMP/tfplan-$e"
               (umask 077; terraform -chdir="$wt/terraform/envs/$e" show -json "$RUNNER_TEMP/tfplan-$e" > "$RUNNER_TEMP/tfplan-$e.json")
```

「GitOps Apply」との違いは、次の2点です。

* 「GitOps Apply」は、承認待ちの変更の種類に応じて確かめるチェックを選ぶ。自動収束は、変更ではなくコミットのコード全体を本実行するので、3つとも確かめる
* パスの判定でスキップされたジョブは、`skipped`になる。スキップは「そのコミットでは対象の変更がなかった」という意味なので、`success`と`skipped`を通過とし、それ以外（`failure`や、チェックが見つからない`missing`など）で止める

止めたときは、**[セクション4](#4-自動で戻す変更と人に返す変更)** と同じく`HOLD`の行を出し、Issueに理由を書き足して、その環境の収束を飛ばします。

この変更をプルリクエスト（PR#110）にし、確認の実行（「GitOps Pipeline」の実行#182）で`changes`ジョブだけが動いたことを確かめて、マージしました（マージコミット`7b9bbd9`、「GitOps Pipeline」の実行#183）。

### ■ 検証内容：ガードレールを通過したコミットへの収束

prodのtarget-node1の`restart`を`always`に変えてから、「Drift Detect」を、`compare_with`を`last-applied`、`converge`を有効にして起動しました（「Drift Detect」の実行#29）。

**▼ 実行結果**（「Drift Detect」の実行#29、`detect`ジョブから抜粋。時刻はUTC）

```plaintext
07:47:10.5545532Z RESULT prod=drift plan_exit_code=2 check_exit_code=0 changed=0 failed_hosts=0
07:47:10.6332382Z == converge prod
07:47:11.3368549Z guardrail prod terraform-static: skipped
07:47:11.9840199Z guardrail prod ansible-lint: success
07:47:12.6432211Z guardrail prod molecule: success
（途中省略：保存したplanのハッシュ値、plan-policy.shの判定）
07:47:14.4395024Z module.lab_env.docker_container.targets["target-node1"]: Modifying... [id=ade38668fb28bd7dc2cea7e840fa4daa000599245f26deaf5c532c8868c45d10]
07:47:14.5797261Z module.lab_env.docker_container.targets["target-node1"]: Modifications complete after 1s [id=ade38668fb28bd7dc2cea7e840fa4daa000599245f26deaf5c532c8868c45d10]
07:47:14.6006131Z Apply complete! Resources: 0 added, 1 changed, 0 destroyed.
（途中省略：Ansibleの本実行。3台ともchanged=0）
07:47:25.6127520Z CONVERGE prod ref=0358b1a4362d4873a56aad5d96c08fa4cca453ce terraform_apply_exit_code=0 ansible_exit_code=0
```

最後に適用したコミット`0358b1a`は、Ansibleの変更だけを含むコミットなので、`terraform-static`はスキップされ、`ansible-lint`と`molecule`は成功しています。ガードレールを通過したため、収束はそのまま進みました。

### ■ 検証内容：ガードレールを通過していないコミットへの収束

パイプラインの外から記録が書き換えられた場合を作ります。ansible-lintが失敗したコミット`ed414d4`（PR#98のマージ、「GitOps Pipeline」の実行#175）を、devの最後に適用したコミットとして1行足します。記録者は、後で見分けて消せるように`gitops19-guardrail-test`にしました。

`ed414d4`のコードで書き出すファイルの中身は、`0358b1a`と同じです。記録を書き換えただけでは差分は出ないため、dev-node1にもドリフトを作ります。

**実行コマンド**

```plaintext
sha=$(git rev-parse ed414d4); echo "sha=$sha"
.github/scripts/applied.sh record dev "$sha" gitops19-guardrail-test; echo "record_exit_code=$?"
.github/scripts/applied.sh last dev
docker exec dev-node1 sed -i 's/ansible-drift-check/manual-edit/' /etc/drift-check-target.conf
docker exec dev-node1 cat /etc/drift-check-target.conf
```

**▼ 実行結果**

```plaintext
sha=ed414d43801fb14cde8aaa3d6efc9547aa5f24ff
record_exit_code=0
ed414d43801fb14cde8aaa3d6efc9547aa5f24ff
monitored_by=manual-edit
```

`applied.sh`は、パイプラインの外からの記録をそのまま受け付け、devの最後に適用したコミットは`ed414d4`になりました。この状態で、「Drift Detect」を、`compare_with`を`last-applied`、`converge`を有効にして起動しました（「Drift Detect」の実行#33）。

**▼ 実行結果**（「Drift Detect」の実行#33、`detect`ジョブから抜粋。時刻はUTC）

```plaintext
08:03:15.2778549Z == dev
08:03:15.3952279Z compare_with=last-applied ref=ed414d43801fb14cde8aaa3d6efc9547aa5f24ff
（途中省略：planは差分なし）
08:03:30.0099931Z changed: dev-node1 common_setup : ドリフト検知の実演用設定ファイルを配置
08:03:30.0119290Z RESULT dev=drift plan_exit_code=0 check_exit_code=0 changed=1 failed_hosts=0
（途中省略：stgとprodは差分なし）
08:04:00.2083048Z == converge dev
08:04:00.8878125Z guardrail dev terraform-static: skipped
08:04:01.5171303Z guardrail dev ansible-lint: failure
08:04:02.1561024Z guardrail dev molecule: skipped
08:04:02.1568642Z HOLD dev guardrail: ansible-lint=failure
（ステップ「Report to issues」）
08:04:03.6995714Z issue #112 created: [drift-detect] dev
```

**▼ 実行結果**（Issue#112の本文）

```plaintext
- 結果: drift
- 比べたコミット: ed414d43801fb14cde8aaa3d6efc9547aa5f24ff
- plan_exit_code=0 check_exit_code=0 changed=1 failed_hosts=0
- 実行: https://github.com/juehara-crypto/ansible-terraform-ci-lab/actions/runs/40839393454
- 時刻: 2026-10-29T08:03:30Z

- changed: dev-node1 common_setup : ドリフト検知の実演用設定ファイルを配置

- 自動収束: 比べたコミットがガードレールを通過していないため、人の判断に返した（ ansible-lint=failure ）
```

### ■ 結果

2つの場合を並べると、次のとおりです。

|項目|ガードレールを通過したコミット（「Drift Detect」の実行#29）|通過していないコミット（「Drift Detect」の実行#33）|
|---|---|---|
|比べたコミット|`0358b1a`（「GitOps Apply」で適用したコミット）|`ed414d4`（パイプラインの外から記録したコミット）|
|`terraform-static`|`skipped`|`skipped`|
|`ansible-lint`|`success`|`failure`|
|`molecule`|`success`|`skipped`（ansible-lintの失敗の後に動いていない）|
|自動収束|保存したplanを適用し、Ansibleも本実行した|`HOLD`で止まり、TerraformもAnsibleも動かなかった|

ガードレールを通過していないコミットが記録に書かれていると、自動収束は本実行の前に止まり、理由をIssueに書き足して人に返しました。記録が書き換えられたことを、自動収束が見抜いたわけではありません。確かめているのは、比べたコミットのチェックの結果だけです。それでも、承認ゲートが適用の前に確かめている条件と同じ条件を、自動収束も適用の前に確かめることで、承認ゲートを通れないコミットが、自動収束を経由して実環境に届くことはなくなります。

検証の後、足した記録を削除し（`DELETE 1`）、devの最後に適用したコミットが`0358b1a`に戻ったことを確かめました。dev-node1のドリフトは、「Drift Detect」を`converge`を有効にして起動して戻し（「Drift Detect」の実行#34、ガードレールは`skipped`・`success`・`success`）、続けて`converge`を無効にして起動し（「Drift Detect」の実行#35）、Issue#112が閉じられたことを確かめています。

### 前提条件2：適用と同じ同時実行のグループで動くこと

自動収束は、「Drift Detect」の同じジョブの中で動きます。「Drift Detect」は、**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** で「GitOps Pipeline」「GitOps Apply」と同じ同時実行のグループに入れてあります。

**▼ 実行結果**（`grep -n -A 2 '^concurrency:'`、3つのワークフロー）

```plaintext
.github/workflows/drift-detect.yml:20:concurrency:
.github/workflows/drift-detect.yml-21-  group: gitops-pipeline
.github/workflows/drift-detect.yml-22-  queue: max
--
.github/workflows/gitops-apply.yml:23:concurrency:
.github/workflows/gitops-apply.yml-24-  group: gitops-pipeline
.github/workflows/gitops-apply.yml-25-  queue: max
--
.github/workflows/gitops-pipeline.yml:11:concurrency:
.github/workflows/gitops-pipeline.yml-12-  group: gitops-pipeline
.github/workflows/gitops-pipeline.yml-13-  queue: max
```

同じグループに入った実行は、前の実行が終わるまで待つことを、**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** で確かめています。自動収束が、承認ゲートからの適用や、マージの実行と重なって動くことはありません。

ただし、**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** で確かめたとおり、守られるのはパイプラインの中の実行どうしだけです。パイプラインの外から実行したTerraformは、stateのロックで止まりますが、保存したplanが拒否されるのは **[セクション3](#3-検知した内容だけを適用する)** のとおり、適用の時点です。パイプラインの外から実行したAnsibleは、どの層でも止められず、自動収束の本実行と重なりえます。

自動収束は、承認ゲートと同じ順序で、同じ条件を確かめてから戻すようになりました。ただし、ここまでの仕組みは、戻した結果を確かめていません。次のセクションでは、戻しても戻りきらない場合に、自動収束を止める仕組みを作ります。

---

[↑ 目次に戻る](#-目次)

---

## 6. 収束しないPlaybookを止める

**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** では、収束しないPlaybookが自動収束に載ると、存在しないずれを直し続けることになると予告しました。実行のたびに「変更あり」になるタスクがあると、検知は毎回「差分あり」と判定し、自動収束は毎回Ansibleを本実行します。毎日のスケジュール実行のたびに本実行が繰り返され、Issueは開いたままになり、本物のドリフトが起きても見分けがつきません。

### 収束の後にもう一度検知する

収束させた環境だけ、同じコードで`plan`と確認モードをもう一度実行し、結果で扱いを分けます。

|収束の後の再検知|結果|扱い|
|---|---|---|
|差分なし|`converged`（収束した）|Issueを閉じる|
|差分が残る|`not_converged`（収束しない）|Issueは開いたまま、ジョブを失敗にする。その環境の自動収束を止める印を置く|

印は、ランナーの`~/gitops-converge-hold/<環境>`というファイルです。置き場所は、**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** の承認待ち（`~/gitops-pending/`）と同じく、ランナーのホームディレクトリにしました。印がある環境は、次の実行から自動収束の対象にしません。検知とIssueの記録は続けます。印を消すのは人です。

これまでは、自動収束で戻しても、その実行の時点ではIssueは開いたままでした。結果を判定するのは収束の前の検知だけで、閉じられるのは次の実行で「差分なし」になったときでした。再検知を入れると、収束した実行の中でIssueを閉じられます。

### ■ 検証内容：収束の後の再検知と、止める印を加える

「Drift Detect」の4か所を書き換えました。

* **収束のループの先頭**：印がある環境は、`HOLD`の行を出してIssueに理由を書き足し、収束を飛ばす
* **収束のループの末尾**：TerraformとAnsibleが失敗しなかった環境だけ再検知する。差分が残っていれば、ジョブを失敗にして印を置く。印には、比べたコミットと実行のURLを書く
* **Issueに残す処理**：`converged`も、`no_drift`と同じく閉じる
* **Clean up**：再検知の結果のファイル（`recheck-*.json`）も消す

**▼ 実行結果**（`git diff`、「Drift Detect」の変更）

```plaintext
@@ -115,6 +115,14 @@ jobs:
               continue
             fi
             echo "== converge $e"
+            if [ -f "$HOME/gitops-converge-hold/$e" ]; then
+              echo "HOLD $e converge-hold: $(cat "$HOME/gitops-converge-hold/$e")"
+              {
+                echo
+                echo "- 自動収束: 収束しなかったため止めている（ランナーの ~/gitops-converge-hold/$e を人が消すまで再開しない）"
+              } >> "$RUNNER_TEMP/report-$e.md"
+              continue
+            fi
             wt="$RUNNER_TEMP/detect-$e"
             ref=$(git -C "$wt" rev-parse HEAD)
             tf_rc=-1; ans_rc=-1
@@ -161,6 +169,29 @@ jobs:
             if [ "$tf_rc" -gt 0 ] || [ "$ans_rc" -gt 0 ]; then
               failed=1
             fi
+            if [ "$tf_rc" -le 0 ] && [ "$ans_rc" -eq 0 ]; then
+              re_plan=0
+              terraform -chdir="$wt/terraform/envs/$e" plan -input=false -no-color -detailed-exitcode -lock-timeout=5m > /dev/null || re_plan=$?
+              re_out="$RUNNER_TEMP/recheck-$e.json"
+              re_check=0
+              (cd "$wt/ansible" && ANSIBLE_STDOUT_CALLBACK=ansible.posix.json ansible-playbook -i "inventories/$e" site.yml --check --diff --vault-id "gitops16@$GITHUB_WORKSPACE/.github/scripts/vault-pass-client.sh" > "$re_out") || re_check=$?
+              re_changed=$(jq '[.stats[].changed] | add // 0' "$re_out") || re_changed=-1
+              jq -r '.plays[].tasks[] | .task.name as $t | .hosts | to_entries[] | select(.value.changed == true) | "changed: \(.key) \($t)"' "$re_out" || true
+              if [ "$re_plan" -eq 0 ] && [ "$re_check" -eq 0 ] && [ "$re_changed" -eq 0 ]; then
+                after=converged
+              else
+                after=not_converged
+                failed=1
+                mkdir -p -m 700 "$HOME/gitops-converge-hold"
+                echo "ref=$ref run=$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" > "$HOME/gitops-converge-hold/$e"
+              fi
+              echo "RECHECK $e=$after plan_exit_code=$re_plan check_exit_code=$re_check changed=$re_changed"
+              printf '%s\n' "$after" > "$RUNNER_TEMP/result-$e"
+              {
+                echo
+                echo "- 収束の後の再検知: $after（plan_exit_code=$re_plan check_exit_code=$re_check changed=$re_changed）"
+              } >> "$RUNNER_TEMP/report-$e.md"
+            fi
           done
           for e in dev stg prod; do
             git worktree remove --force "$RUNNER_TEMP/detect-$e" 2> /dev/null || true
@@ -176,7 +207,7 @@ jobs:
               echo "$e: no result"
               continue
             fi
-            if [ "$(cat "$RUNNER_TEMP/result-$e")" = "no_drift" ]; then
+            if [ "$(cat "$RUNNER_TEMP/result-$e")" = "no_drift" ] || [ "$(cat "$RUNNER_TEMP/result-$e")" = "converged" ]; then
               action=close
             else
               action=open
@@ -186,5 +217,5 @@ jobs:
       - name: Clean up
         if: always()
         run: |
-          rm -rf "$RUNNER_TEMP/keys" "$RUNNER_TEMP"/check-*.json "$RUNNER_TEMP"/result-* "$RUNNER_TEMP"/report-*.md "$RUNNER_TEMP"/tfplan-* "$RUNNER_TEMP"/plan_rc-*
+          rm -rf "$RUNNER_TEMP/keys" "$RUNNER_TEMP"/check-*.json "$RUNNER_TEMP"/result-* "$RUNNER_TEMP"/report-*.md "$RUNNER_TEMP"/tfplan-* "$RUNNER_TEMP"/plan_rc-* "$RUNNER_TEMP"/recheck-*.json
           git worktree prune
```

この変更をプルリクエスト（PR#113）にし、確認の実行（「GitOps Pipeline」の実行#184）で`changes`ジョブだけが動いたことを確かめて、マージしました（マージコミット`ac7ce2b`、「GitOps Pipeline」の実行#185）。

### ■ 検証内容：収束しないタスクを用意する

収束しないタスクは、検知に毎回「差分あり」として現れる必要があります。**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** で整理したとおり、`command`や`shell`のタスクは確認モードでスキップされ、検知に現れません。そこで、`copy`のタスクの内容に、実行のたびに変わる値（制御ノードの`date +%s%N`）を入れました。

タスクを置く場所は、ロールの外（`site.yml`）にしました。Moleculeの冪等性のテストが対象にしているのは、ロール`common_setup`だけです。ロールの外に置いたタスクは、Moleculeでは見つかりません。

**▼ 実行結果**（`cat -n ansible/site.yml`）

```plaintext
     1  ---
     2  - name: 接続確認用Playbook
     3    hosts: target_nodes
     4    gather_facts: false
     5    tasks:
     6      - name: 疎通確認
     7        ansible.builtin.ping:
     8      - name: 収束しないファイルを配置（第19回の検証用）
     9        become: true
    10        ansible.builtin.copy:
    11          dest: /etc/gitops19-nonconverge.conf
    12          content: "generated_at={{ lookup('pipe', 'date +%s%N') }}\n"
    13          mode: "0644"
    14    roles:
    15      - common_setup
```

このタスクを、プルリクエスト（PR#114）からマージし（マージコミット`f3d4f75`）、「GitOps Apply」でdevだけに適用しました（「GitOps Apply」の実行#103）。stgとprodには適用していないので、最後に適用したコミットは`0358b1a`のままです。

確認の実行（「GitOps Pipeline」の実行#186）でも、マージの実行（「GitOps Pipeline」の実行#187）でも、`ansible-lint`と`molecule`は成功しました。**[セクション5](#5-収束の順序と前提条件)** のガードレールの確認も、このコミットでは通ります。

手元で、ansible-lintと、devへの確認モードを2回実行しました。

**実行コマンド**

```plaintext
cd ansible
ANSIBLE_INVENTORY_UNPARSED_FAILED=False ansible-lint --nocolor; echo "exit_code=$?"
for i in 1 2; do ansible-playbook -i inventories/dev site.yml --check --diff --vault-id "gitops16@$HOME/.config/ansible-vault/gitops16-vault-pass" 2>/dev/null | grep -E 'generated_at|: ok='; done
```

**▼ 実行結果**

```plaintext
Passed: 0 failure(s), 0 warning(s) in 18 files processed of 19 encountered. Last profile that met the validation criteria was 'production'.
exit_code=0
-generated_at=1793263300971640451
+generated_at=1793263573525782003
dev-node1                  : ok=7    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
-generated_at=1793263300971640451
+generated_at=1793263592559167923
dev-node1                  : ok=7    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

ansible-lintは通り、確認モードは2回とも`changed=1`になりました。`+generated_at=`の値は、実行のたびに違います。このタスクは、何度適用しても「変更あり」のままです。

### ■ 検証内容：収束しないPlaybookで自動収束させる

「Drift Detect」を、`compare_with`を`last-applied`、`converge`を有効にして起動しました（「Drift Detect」の実行#36）。

**▼ 実行結果**（「Drift Detect」の実行#36、`detect`ジョブから抜粋。時刻はUTC）

```plaintext
08:48:09.2131097Z == dev
08:48:09.4600825Z compare_with=last-applied ref=f3d4f7543ababff27607b24b336f92717117d147
（途中省略：planは差分なし）
08:48:41.9213854Z changed: dev-node1 収束しないファイルを配置（第19回の検証用）
08:48:41.9246520Z RESULT dev=drift plan_exit_code=0 check_exit_code=0 changed=1 failed_hosts=0
（途中省略：stgとprodは差分なし）
08:49:49.5588001Z == converge dev
08:49:50.3125101Z guardrail dev terraform-static: skipped
08:49:51.0512696Z guardrail dev ansible-lint: success
08:49:51.7903655Z guardrail dev molecule: success
（途中省略：Ansibleの本実行。ほかのタスクはok）
08:50:07.6809802Z TASK [収束しないファイルを配置（第19回の検証用）] ******************************
08:50:12.3613222Z --- before: /etc/gitops19-nonconverge.conf
08:50:12.3615818Z +++ after: /etc/gitops19-nonconverge.conf
08:50:12.3618555Z @@ -1 +1 @@
08:50:12.3620106Z -generated_at=1793263300971640451
08:50:12.3621075Z +generated_at=1793263807740510711
08:50:12.3621970Z changed: [dev-node1]
08:50:12.3736357Z dev-node1                  : ok=7    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
08:50:12.5718921Z CONVERGE dev ref=f3d4f7543ababff27607b24b336f92717117d147 terraform_apply_exit_code=-1 ansible_exit_code=0
08:50:36.1909742Z changed: dev-node1 収束しないファイルを配置（第19回の検証用）
08:50:36.2051962Z RECHECK dev=not_converged plan_exit_code=0 check_exit_code=0 changed=1
08:50:36.2885160Z ##[error]Process completed with exit code 1.
（ステップ「Report to issues」）
08:50:38.2576908Z issue #115 created: [drift-detect] dev
```

Ansibleの本実行は成功し（`ansible_exit_code=0`）、ファイルは書き換わりました。ところが、その直後の再検知でも同じタスクが`changed`になり、`RECHECK dev=not_converged`と判定されました。ジョブは失敗になり、Issue#115が作られています。

**▼ 実行結果**（Issue#115の本文）

```plaintext
- 結果: drift
- 比べたコミット: f3d4f7543ababff27607b24b336f92717117d147
- plan_exit_code=0 check_exit_code=0 changed=1 failed_hosts=0
- 実行: https://github.com/juehara-crypto/ansible-terraform-ci-lab/actions/runs/40844736795
- 時刻: 2026-10-29T08:48:41Z

- changed: dev-node1 収束しないファイルを配置（第19回の検証用）

- 収束の後の再検知: not_converged（plan_exit_code=0 check_exit_code=0 changed=1）
```

ランナーには、止める印が置かれました。

**実行コマンド**

```plaintext
ls -la ~/gitops-converge-hold
cat ~/gitops-converge-hold/dev
docker exec dev-node1 cat /etc/gitops19-nonconverge.conf
```

**▼ 実行結果**

```plaintext
total 12
drwx------  2 control control 4096 Oct 29 08:50 .
drwxr-x--- 15 control control 4096 Oct 29 08:50 ..
-rw-r--r--  1 control control  133 Oct 29 08:50 dev
ref=f3d4f7543ababff27607b24b336f92717117d147 run=https://github.com/juehara-crypto/ansible-terraform-ci-lab/actions/runs/40844736795
generated_at=1793263807740510711
```

印には、収束しなかったときに比べたコミットと、その実行のURLが書かれています。印を見た人は、どの実行で止まったのかをたどれます。

### ■ 検証内容：止めた環境では自動収束が動かない

毎日のスケジュール実行で、もう一度自動収束が動いた場合を想定して、同じ入力で起動しました（「Drift Detect」の実行#37）。

**▼ 実行結果**（「Drift Detect」の実行#37、`detect`ジョブから抜粋。時刻はUTC）

```plaintext
08:55:23.8831642Z == dev
08:55:24.1317143Z compare_with=last-applied ref=f3d4f7543ababff27607b24b336f92717117d147
（途中省略：planは差分なし）
08:56:00.1089109Z changed: dev-node1 収束しないファイルを配置（第19回の検証用）
08:56:00.1093453Z RESULT dev=drift plan_exit_code=0 check_exit_code=0 changed=1 failed_hosts=0
（途中省略：stgとprodは差分なし）
08:57:05.7900546Z == converge dev
08:57:05.7987458Z HOLD dev converge-hold: ref=f3d4f7543ababff27607b24b336f92717117d147 run=https://github.com/juehara-crypto/ansible-terraform-ci-lab/actions/runs/40844736795
（ステップ「Report to issues」）
08:57:08.1943633Z issue #115 updated: [drift-detect] dev
```

検知は、また差分ありと判定しました。収束のループに入ったところで印が見つかり、`HOLD`の行が出ています。ガードレールの確認も、Ansibleの本実行も、再検知も行われていません。dev-node1のファイルは、「Drift Detect」の実行#36で書き換わった`generated_at=1793263807740510711`のままでした。`detect`ジョブは成功しています。止めた環境では、検知とIssueの記録だけが続きます。

**▼ 実行結果**（Issue#115の本文、「Drift Detect」の実行#37で書き換わった後）

```plaintext
- 結果: drift
- 比べたコミット: f3d4f7543ababff27607b24b336f92717117d147
- plan_exit_code=0 check_exit_code=0 changed=1 failed_hosts=0
- 実行: https://github.com/juehara-crypto/ansible-terraform-ci-lab/actions/runs/40845612146
- 時刻: 2026-10-29T08:56:00Z

- changed: dev-node1 収束しないファイルを配置（第19回の検証用）

- 自動収束: 収束しなかったため止めている（ランナーの ~/gitops-converge-hold/dev を人が消すまで再開しない）
```

`report-issue.sh`は、開いているIssueの本文を最新の結果で書き換えます。「Drift Detect」の実行#36の再検知の行は消え、止めている理由に置き換わりました。どの実行で止まったかは、印に書かれたURLからたどれます。

### ■ 検証内容：印を消すと収束が再開する

止めた後に人が行う作業を、後片付けを兼ねて確かめました。

1. 収束しないタスクを取り除く変更を、プルリクエスト（PR#116）からマージし（マージコミット`cdd5e6a`）、「GitOps Apply」でdev、stg、prodの順に適用した（「GitOps Apply」の実行#104、#105、#106）
2. タスクを取り除いても、dev-node1に置かれたファイルは残った。**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)** で確かめた、revertしてもOSは戻らないのと同じなので、ファイルは手で消した
3. 印を消した

印を消した後、自動収束が戻せる変更を作って確かめます。dev-node1で、Playbookが管理するファイル`/etc/gitops-env.conf`に1行足しました。

**実行コマンド**

```plaintext
docker exec dev-node1 rm /etc/gitops19-nonconverge.conf
rm ~/gitops-converge-hold/dev
rmdir ~/gitops-converge-hold
docker exec dev-node1 sh -c 'echo "manual-edit=gitops19-resume" >> /etc/gitops-env.conf'
docker exec dev-node1 cat /etc/gitops-env.conf
```

**▼ 実行結果**

```plaintext
env=dev
promotion=dev-stg-prod
gitops17=pending-check
gitops18=pending-detect
gitops18=promote-check
gitops19=pending-converge
manual-edit=gitops19-resume
```

「Drift Detect」を、`compare_with`を`last-applied`、`converge`を有効にして起動しました（「Drift Detect」の実行#38）。

**▼ 実行結果**（「Drift Detect」の実行#38、`detect`ジョブから抜粋。時刻はUTC）

```plaintext
09:30:03.4292744Z == dev
09:30:03.6894703Z compare_with=last-applied ref=cdd5e6afec9f97ba7ef478d3f0de9ffb46f7bd16
（途中省略：planは差分なし）
09:30:32.7335860Z changed: dev-node1 common_setup : 環境の名前を書いたファイルを配置
09:30:32.7375050Z RESULT dev=drift plan_exit_code=0 check_exit_code=0 changed=1 failed_hosts=0
（途中省略：stgとprodは差分なし）
09:31:29.9663273Z == converge dev
09:31:30.7903616Z guardrail dev terraform-static: skipped
09:31:31.5159280Z guardrail dev ansible-lint: success
09:31:32.2781338Z guardrail dev molecule: success
（途中省略：Ansibleの本実行）
09:31:42.4976009Z --- before: /etc/gitops-env.conf
09:31:42.4979970Z +++ after: /etc/gitops-env.conf
09:31:42.4981632Z @@ -4,4 +4,3 @@
09:31:42.4990100Z  gitops18=pending-detect
09:31:42.5003488Z  gitops18=promote-check
09:31:42.5007184Z  gitops19=pending-converge
09:31:42.5009182Z -manual-edit=gitops19-resume
09:31:42.5013847Z changed: [dev-node1]
09:31:49.3395904Z dev-node1                  : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
09:31:49.5335173Z CONVERGE dev ref=cdd5e6afec9f97ba7ef478d3f0de9ffb46f7bd16 terraform_apply_exit_code=-1 ansible_exit_code=0
09:32:08.3065773Z RECHECK dev=converged plan_exit_code=0 check_exit_code=0 changed=0
（ステップ「Report to issues」）
09:32:12.1353727Z issue #115 closed: [drift-detect] dev
```

印がなくなったので、`HOLD`の行は出ず、ガードレールの確認から収束が進みました。足した行はAnsibleの本実行で消え、再検知は`changed=0`で`RECHECK dev=converged`になりました。Issue#115は、同じ実行の中で閉じられています。

**▼ 実行結果**（Issue#115を閉じたときのコメント）

```plaintext
解消しました。

- 結果: drift
- 比べたコミット: cdd5e6afec9f97ba7ef478d3f0de9ffb46f7bd16
- plan_exit_code=0 check_exit_code=0 changed=1 failed_hosts=0
- 実行: https://github.com/juehara-crypto/ansible-terraform-ci-lab/actions/runs/40850070004
- 時刻: 2026-10-29T09:30:32Z

- changed: dev-node1 common_setup : 環境の名前を書いたファイルを配置

- 収束の後の再検知: converged（plan_exit_code=0 check_exit_code=0 changed=0）
```

### ■ 結果

3回の実行を並べると、次のとおりです。

|項目|「Drift Detect」の実行#36|「Drift Detect」の実行#37|「Drift Detect」の実行#38|
|---|---|---|---|
|印|なし|あり|なし（人が消した）|
|収束の前の検知|`drift`（`changed=1`）|`drift`（`changed=1`）|`drift`（`changed=1`）|
|Ansibleの本実行|した（`ansible_exit_code=0`）|しなかった（`HOLD`）|した（`ansible_exit_code=0`）|
|収束の後の再検知|`not_converged`（`changed=1`）|行わなかった|`converged`（`changed=0`）|
|印の扱い|置いた|そのまま|置かなかった|
|Issue#115|作られた|本文が書き換わった|閉じられた|
|`detect`ジョブ|失敗|成功|成功|

収束しないPlaybookでも、自動収束の本実行は1回で止まりました。2回目からは、検知とIssueの記録だけが続き、人が印を消すまで本実行しません。Ansibleの本実行が成功しても（`ansible_exit_code=0`）、収束したとは限りません。収束したかどうかを決めているのは、本実行の終了コードではなく、その後の再検知です。

ただし、再検知で見えるのは、検知で見えるものだけです。確認モードで「変更なし」に見えるタスクは、本実行で毎回中身を変えていても、印を置かれることはありません。

次のセクションでは、このように自動収束が見えないもの、戻せないものを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 7. 自動収束が直せないもの

ここまでで、自動収束は、検知で見つけた差分を、承認を経て適用した状態に戻すようになりました。ただし、自動収束が扱えるのは、検知が差分として表示したものだけです。このセクションでは、自動収束が直せないものと、直せても自動では直さないものを整理します。

### 検知に現れないものは、収束の対象にならない

**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)** では、ドリフトを、検出できるツールで3つに分けました。

|検出範囲|比べているもの|自動収束|
|---|---|---|
|Terraformの`plan`で検出できる|tfstateに記録されたリソースの属性と、実際の属性|対象になる|
|Ansibleの`--check`で検出できる|タスクに書かれたあるべき状態と、実際の状態|対象になる|
|どちらでも検出できない|（比べる対象がない）|対象にならない|

この回の自動収束は、**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** の検知の結果が「差分あり」になった環境だけを戻します。どちらでも検出できない範囲は、検知で「差分なし」と表示されるため、自動収束はその環境に何もしません。この範囲には、次の3つが入ります。

* **記述・記録されていない要素**：Playbookのどのタスクにも書かれておらず、tfstateにも記録されていないもの
* **revertの残骸**：タスクを取り除いても、操作対象に残ったもの
* **`ignore_changes`で意図して外した属性**：作り直しを避けるために、`plan`の判断から外したもの

revertの残骸は、この回の **[セクション6](#6-収束しないplaybookを止める)** の後片付けでも現れました。収束しないタスクを取り除くコミット`cdd5e6a`を、dev、stg、prodに適用した後も、dev-node1の`/etc/gitops19-nonconverge.conf`は`generated_at=1793263807740510711`のまま残っていました。タスクを取り除いた時点で、このファイルはどのタスクにも書かれていません。自動収束が戻す先の「最後に適用したコミット」にも書かれていないため、自動収束では消せません。この回では、手で消しました。

### 確認モードで「変更なし」に見えるもの

検知が「差分あり」と表示しないものは、検出できる範囲の中にもあります。

**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** で確かめたとおり、`command`や`shell`のタスクは確認モードでスキップされます。`changed_when: false`のように表示を変えるだけの書き方では、本実行で中身を変えていても`ok`と表示されます。こうしたタスクが管理しているものがずれても、検知は「差分なし」と表示し、自動収束は動きません。

逆に、ほかのタスクが原因で自動収束が動いたときは、こうしたタスクも本実行で毎回実行されます。**[セクション6](#6-収束しないplaybookを止める)** の再検知も確認モードで判定するため、止める印は置かれません。収束しないPlaybookを止める仕組みが止められるのは、検知に「変更あり」として現れるタスクだけです。

### 直せても、自動では直さないもの

検知で見つけた差分の中にも、自動収束が戻さずに人に返すものがあります。この回で作った判定を並べると、次のとおりです。

|自動収束が人に返す場合|理由|確かめたセクション|
|---|---|---|
|作り直し・削除・作成を含む|Ansibleで入れた設定が消えたり、承認なしにリソースが増減したりする|**[セクション4](#4-自動で戻す変更と人に返す変更)**|
|検知失敗|何がずれているのかが分からないまま適用することになる|**[セクション4](#4-自動で戻す変更と人に返す変更)**|
|比べたコミットがガードレールを通過していない|承認ゲートを通れないコミットが、自動収束を経由して実環境に届く|**[セクション5](#5-収束の順序と前提条件)**|
|前の実行で収束しなかった（止める印がある）|同じ本実行を繰り返しても、収束しない|**[セクション6](#6-収束しないplaybookを止める)**|

これらは、自動収束が直せないものではありません。適用すれば戻せるかもしれないものを、人の承認なしには戻さないと決めたものです。戻すかどうかは、Issueに残った理由を見て人が判断し、**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** の承認ゲートを通して適用します。

### 戻す先が正しいとは限らない

自動収束が戻す先は、最後に適用したコミットです。そのコミットのコードが、望ましい状態を書けているとは限りません。

**[セクション6](#6-収束しないplaybookを止める)** の収束しないタスクは、ansible-lintとMoleculeを通り、承認ゲートを通ってdevに適用されました。自動収束は、承認を経たコードに忠実に戻しただけです。再検知で止まったのは、コードの書き方が冪等でなかったからで、コードの内容が誤っていたからではありません。冪等であっても誤った値が書かれたコードは、承認を通れば、自動収束によって毎日確実にその誤った値に戻されます。

自動収束が保証しているのは、実環境を承認を経た状態にそろえることだけです。承認を経た状態が正しいかどうかは、プルリクエストのレビューと、ガードレールと、承認ゲートで判断することになります。

### 自動収束は「防ぐ」を代替しない

**[ドリフトシリーズ第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-04/)** では、ドリフトへの対処を、防ぐ・検知する・修正するの3つの設計に整理しました。この回の自動収束は「修正する」にあたり、「検知する」の結果の上に作っています。検知に現れないものは、修正の対象にもなりません。

どちらでも検出できない範囲に対してできることは、ずれた後に直すことではなく、検出できない範囲そのものを狭めることです。記述・記録されていない要素を管理の対象に入れること、revertの残骸を作らない変更の仕方をとること、`ignore_changes`で外した属性を記録しておくことは、「防ぐ」の設計にあたります。この設計は、**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)** で扱います。

ここまでは、自動収束が直せないもの、直さないものを見てきました。次のセクションでは逆に、直してはいけないものまで直してしまう場合として、障害対応で加えた手動変更が自動収束で元に戻されることを確かめます。

---

[↑ 目次に戻る](#-目次)

---

## 8. 手動変更は自動で消される

**[セクション7](#7-自動収束が直せないもの)** では、自動収束が直せないものを整理しました。このセクションでは逆に、直してはいけないものまで直してしまう場合を確かめます。障害対応で加えた手動変更です。

### 自動収束には、手動変更の意図が見えない

**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)** では、最後に適用したコミットと実環境の差をドリフトとしました。障害対応で担当者が手で加えた変更も、最後に適用したコミットには書かれていないので、ドリフトです。自動収束から見ると、うっかり加えた変更と、障害を抑えるために意図して加えた変更は、同じ「差分あり」として表示されます。

### ■ 検証内容：障害対応の手動変更を加える

prodのtarget-node1で障害が起き、担当者が次の2つを手で変えた想定にしました。Terraformが管理するものと、Ansibleが管理するものを1つずつ選んでいます。

|変更|管理しているもの|担当者の意図|
|---|---|---|
|`restart`を`always`にする|Terraform（`docker_container`の`restart`）|落ちても自動で上がるようにしておく|
|設定ファイルに1行足す|Ansible（ロール`common_setup`が置く`/etc/drift-check-target.conf`）|障害対応中であることを書き残す|

変更の前の時点で、3環境とも、最後に適用したコミットは`cdd5e6a`でした。承認待ちも、止める印も、開いているIssueもありません。

**実行コマンド**

```plaintext
docker update --restart=always target-node1
docker exec target-node1 sh -c 'echo "# 障害対応中（2026-10-29）: 再起動の方針をalwaysに変更。対応が終わるまで戻さないこと" >> /etc/drift-check-target.conf'
docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' target-node1
docker exec target-node1 cat /etc/drift-check-target.conf
```

**▼ 実行結果**

```plaintext
target-node1
always
monitored_by=ansible-drift-check
# 障害対応中（2026-10-29）: 再起動の方針をalwaysに変更。対応が終わるまで戻さないこと
```

### ■ 検証内容：次の自動収束で何が起きるか

この回の「Drift Detect」は、スケジュール実行のときは`converge`が無効のままです（スケジュール実行には入力がないため）。ここでは、スケジュール実行で収束を有効にしていた場合を想定して、`compare_with`を`last-applied`、`converge`を有効にして、手動で起動しました（「Drift Detect」の実行#39）。

**▼ 実行結果**（「Drift Detect」の実行#39、`detect`ジョブから抜粋。時刻はUTC）

```plaintext
09:51:54.7728587Z == prod
09:51:54.9510109Z compare_with=last-applied ref=cdd5e6afec9f97ba7ef478d3f0de9ffb46f7bd16
（途中省略）
09:52:05.7828556Z   # module.lab_env.docker_container.targets["target-node1"] will be updated in-place
09:52:05.7830665Z   ~ resource "docker_container" "targets" {
09:52:05.7832486Z         id                                          = "ade38668fb28bd7dc2cea7e840fa4daa000599245f26deaf5c532c8868c45d10"
09:52:05.7834395Z         name                                        = "target-node1"
09:52:05.7835985Z       ~ restart                                     = "always" -> "no"
09:52:05.7837369Z         # (48 unchanged attributes hidden)
（途中省略）
09:52:05.7840503Z Plan: 0 to add, 1 to change, 0 to destroy.
（途中省略：Ansibleの確認モード）
09:52:29.2470798Z changed: target-node1 common_setup : ドリフト検知の実演用設定ファイルを配置
09:52:29.2485679Z RESULT prod=drift plan_exit_code=2 check_exit_code=0 changed=1 failed_hosts=0
09:52:29.3592784Z == converge prod
09:52:30.1565706Z guardrail prod terraform-static: skipped
09:52:30.9459983Z guardrail prod ansible-lint: success
09:52:31.7299597Z guardrail prod molecule: success
09:52:31.7502904Z 2b918df1ef72eefb2ad64a12b17b23792d51b85e7f1ed6f35c88259eb3251dd3  /home/control/actions-runner/_work/_temp/tfplan-prod
09:52:33.6773044Z PASS  module.lab_env.docker_container.targets["target-node1"] actions=update
09:52:33.7679572Z policy: pass
09:52:35.9693148Z module.lab_env.docker_container.targets["target-node1"]: Modifying... [id=ade38668fb28bd7dc2cea7e840fa4daa000599245f26deaf5c532c8868c45d10]
09:52:36.1640045Z module.lab_env.docker_container.targets["target-node1"]: Modifications complete after 0s [id=ade38668fb28bd7dc2cea7e840fa4daa000599245f26deaf5c532c8868c45d10]
09:52:36.2413648Z Apply complete! Resources: 0 added, 1 changed, 0 destroyed.
（途中省略：Ansibleの本実行）
09:52:46.1019028Z --- before: /etc/drift-check-target.conf
09:52:46.1021085Z +++ after: /etc/drift-check-target.conf
09:52:46.1022908Z @@ -1,2 +1 @@
09:52:46.1024344Z  monitored_by=ansible-drift-check
09:52:46.1027335Z -# 障害対応中（2026-10-29）: 再起動の方針をalwaysに変更。対応が終わるまで戻さないこと
09:52:46.1032592Z changed: [target-node1]
（途中省略）
09:53:02.2637718Z target-node1               : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
09:53:02.2640245Z target-node2               : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
09:53:02.2643393Z target-node3               : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
09:53:02.4460633Z CONVERGE prod ref=cdd5e6afec9f97ba7ef478d3f0de9ffb46f7bd16 terraform_apply_exit_code=0 ansible_exit_code=0
09:53:30.8779535Z RECHECK prod=converged plan_exit_code=0 check_exit_code=0 changed=0
（ステップ「Report to issues」）
09:53:33.4699723Z no open issue: [drift-detect] prod
```

**実行コマンド**

```plaintext
docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' target-node1
docker exec target-node1 cat /etc/drift-check-target.conf
```

**▼ 実行結果**

```plaintext
no
monitored_by=ansible-drift-check
```

### ■ 結果

|項目|障害対応の後|「Drift Detect」の実行#39の後|
|---|---|---|
|target-node1の`restart`|`always`|`no`|
|`/etc/drift-check-target.conf`|障害対応中であることを書いた行がある|行が消え、元の1行に戻った|
|検知・収束|―|`drift`→ガードレール通過→`policy: pass`→適用→`converged`|
|Issue|開いているものはない|作られていない（`no open issue`）|
|`detect`ジョブ|―|成功|

障害対応で加えた2つの変更は、1回の実行で、どちらも元に戻されました。`restart`の変更は、作り直しも削除も含まない属性の変更なので、**[セクション4](#4-自動で戻す変更と人に返す変更)** の判定でも人に返されません。この回で作った判定はどれも、この変更を止めませんでした。

自動収束は、正しく動いています。最後に適用したコミットに戻し、検知した差分だけを適用し、ガードレールを確かめ、再検知で収束したことも確かめました。問題は、戻した変更が、障害を抑えるために意図して加えたものだったことです。担当者が残した「対応が終わるまで戻さないこと」という行も、ドリフトの一部として消されています。手動変更の意図を実環境の中に書き残しても、自動収束は、それを書かれていない差分として扱います。

さらに、この実行は何も残していません。再検知で`converged`になった環境のIssueは閉じるだけなので、もともとIssueが開いていなかったprodでは、Issueは作られませんでした。`detect`ジョブも成功しています。障害対応の担当者から見ると、手で加えた変更が、知らない間に消えていたことになります。戻されたことを知る手がかりは、この実行のログだけです。

### 障害対応の手動変更は、GitOpsとぶつかる

企画書で挙げた3つ目のハマりどころ「手動で直した設定がGitOpsで上書きされる」は、これまでは、次に変更をマージして適用したときに起きる問題でした。適用は承認ゲートを通るため、少なくとも人が適用を起動していました。自動収束を入れると、人が何もしなくても、次の実行で上書きされます。

障害対応の手動変更を禁止すれば、この問題は起きません。しかし、障害の最中に、プルリクエストを作ってガードレールを通し、承認ゲートからdev、stg、prodの順に適用する時間は取れないことがあります。障害対応と自動収束を両立させるには、障害対応の変更でもGitを経由できる速い経路と、それでも手で変えたときに、自動収束に「今は戻さない」ことを伝える方法と、手で加えた変更を後からGitに取り込む流れが必要です。どれも、いつ、誰が、いつまで例外にしたのかを記録に残す形にしなければ、例外がそのまま新しいドリフトになります。この設計は、**[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-20/)** で扱います。

次のセクションでは、この回の設計が、クラウドのプロバイダーでも変わらないことを示します。

---

[↑ 目次に戻る](#-目次)

---

## 9. クラウドでも同じ設計で収束できる

この回の検証は、Dockerのプロバイダーで行いました。クラウドのプロバイダーで自動収束を動かすときに加わる点と、プロバイダーによらず同じ点を整理します。

### 人に返す変更の重さが増す

**[セクション4](#4-自動で戻す変更と人に返す変更)** では、作り直し・削除・作成を含む変更を、自動収束の対象から外しました。この検証環境では、作り直されるのはコンテナで、失うのはAnsibleで入れた設定でした。

クラウドで作り直されるのは、仮想マシンやデータベースのような、長く動き続けることを前提にしたリソースです。作り直しは、次のような影響につながります。

* 仮想マシンが止まり、作り直しが終わるまでサービスが止まる
* 割り当てられたIPアドレスが変わり、Ansibleのインベントリや、ほかのシステムからの接続先とずれる
* 仮想マシンのローカルのディスクに置いたデータや、Ansibleで入れた設定が消える

作り直しを人に返す判定は、クラウドでは、検証環境よりも重い意味を持ちます。

ただし、**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** の`plan-policy.sh`が見ているのは、planのJSONの`actions`だけです。その場の更新（`update`）は通ります。その場の更新が、クラウドの側でどう実現されるかは、プロバイダーの実装によります。`actions`だけでは、更新のときにリソースが止まるかどうかは分かりません。自動で戻してよい変更の範囲は、使うプロバイダーとリソースの種類ごとに見直すことになります。

### 収束は、検知よりも強い権限を必要とする

**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** では、検知は読み取りだけで済むため、適用とは別の、読み取りだけの権限を持つロールを使う形にもできると整理しました。自動収束を同じジョブに入れると、このジョブは、保存したplanを適用し、Ansibleを本実行します。読み取りだけのロールでは足りず、適用と同じ権限が必要になります。

クラウドでは、この権限が、クラウドのアカウントの中のリソースを変更する権限になります。GitHub ActionsのOIDCで、ジョブごとに短い期間のトークンを受け取る形にしても、スケジュールで毎日動くジョブが、承認なしに適用できる権限を持つことは変わりません。**[セクション4](#4-自動で戻す変更と人に返す変更)** から **[セクション6](#6-収束しないplaybookを止める)** で作った判定は、この権限で何を実行してよいかを、ジョブの中で絞るものでもあります。

### APIの呼び出しが増える

自動収束を入れると、1つの環境につき、検知の`plan`に加えて、保存したplanの適用と、**[セクション6](#6-収束しないplaybookを止める)** の再検知の`plan`が動きます。クラウドでは、どれもクラウドのAPIの呼び出しになり、同じアカウント・リージョンで動く適用や、ほかの自動化と同じ制限を使います。

制限に当たって`plan`や適用がエラーで終わったときは、この回の判定がそのまま使えます。検知の`plan`がエラーで終われば「検知失敗」になり、自動収束は動きません。適用がエラーで終われば`terraform_apply_exit_code`が1になり、Ansibleは本実行されず、ジョブは失敗になります。

### 手動変更の経路が増える

**[セクション8](#8-手動変更は自動で消される)** では、`docker update`と`docker exec`で手動変更を加えました。クラウドでは、管理コンソールやCLIからの変更、クラウドの別の自動化の仕組みからの変更が加わります。障害の最中には、管理コンソールから直接、設定を変えることもあります。

どの経路から変わっても、自動収束は、最後に適用したコミットにないものとして戻します。経路が増えると、意図して加えた変更が戻される機会も増えます。

### プロバイダーによらず同じこと

|設計|この回で確かめたこと|プロバイダーとの関係|
|---|---|---|
|収束先を承認済みの状態に限る|mainではなく、環境ごとに最後に適用したコミットに戻す（**[セクション2](#2-mainへ収束させると承認ゲートを迂回する)**）|最後に適用したコミットの記録は、パイプラインの側にある|
|検知した内容だけを適用する|検知の時点で保存したplanを適用し、その後にtfstateが変わったら`Saved plan is stale`で止まる（**[セクション3](#3-検知した内容だけを適用する)**）|保存したplanの扱いは、Terraformの側の動き|
|自動で戻す変更を限る|作り直し・削除・作成と検知失敗は人に返す（**[セクション4](#4-自動で戻す変更と人に返す変更)**）|判定はplanのJSONを読むだけ。何を外すかの重さはプロバイダーによる|
|適用と同じ条件で戻す|Terraform→Ansibleの順で戻し、ガードレールの結果を確かめ、同じ同時実行のグループで動く（**[セクション5](#5-収束の順序と前提条件)**）|読むのはGitHubのAPIだけ|
|収束しないときに止める|再検知で差分が残れば印を置き、人が消すまで自動収束を止める（**[セクション6](#6-収束しないplaybookを止める)**）|印はランナーの上にある|

クラウドで変わるのは、作り直しの影響の大きさ、収束に必要な権限、APIの制限、手動変更の経路です。何に戻し、何を戻さず、どこで止まるかは、プロバイダーによって変わりません。

---

[↑ 目次に戻る](#-目次)

---

## 10. まとめ

この回で整理した内容を確認します。

* 自動収束の収束先をmainにすると、承認を待っている変更まで適用される。mainへ収束させた実行では、承認を待っていた1行が、「GitOps Apply」を1回も起動しないまま、dev・stg・prodの5台すべてに入った。最後に適用したコミットの記録は変わらず、記録と実環境がずれた。収束先を環境ごとに最後に適用したコミットにすると、ドリフトだけが戻り、承認を待っている変更は入らなかった
* 自動収束は、検知の時点で保存したplanを適用し、検知で見つけた差分だけを戻す。検知でplanを保存した後にtfstateが変わると、保存したplanは`Saved plan is stale`で拒否され、Ansibleも本実行されなかった。Ansibleは、差分ありと判定した環境でだけ本実行する
* 作り直し・削除・作成を含む変更と、検知失敗は、自動収束の対象から外して人に返す。イメージの名前を外したdevは、コンテナの作り直しを含むため、TerraformもAnsibleも動かずにIssueに理由が残った。接続できないstgは、検知失敗として収束の対象にならなかった。属性だけが変わったprodは、その場の更新として戻った
* 自動収束は、承認ゲートと同じ順序と条件で戻す。Terraform→Ansibleの順で戻し、比べたコミットのガードレールの結果を、本実行の前に確かめる。ansible-lintが失敗したコミットを、パイプラインの外から最後に適用したコミットとして記録すると、自動収束は`HOLD`で止まった。「Drift Detect」は、「GitOps Pipeline」「GitOps Apply」と同じ同時実行のグループで動く
* 収束しないPlaybookは、自動収束を繰り返させる。収束の後に同じコードでもう一度検知し、差分が残れば`not_converged`としてジョブを失敗にし、ランナーに印を置く。実行のたびに内容が変わるタスクでは、Ansibleの本実行が成功しても再検知で差分が残り、次の実行からは、印を人が消すまで本実行しなかった。印を消すと収束が再開し、`converged`になった実行の中でIssueが閉じられた。ただし、確認モードで「変更なし」に見えるタスクは、再検知でも止められない
* 自動収束が扱えるのは、検知が差分として表示したものだけである。記述・記録されていない要素、revertの残骸、`ignore_changes`で外した属性は、検知にも収束にも現れない。収束しないタスクを取り除いた後も、そのタスクが置いたファイルは残り、手で消した
* 障害対応で加えた手動変更も、自動収束はドリフトとして戻す。prodのtarget-node1で`restart`を`always`にし、設定ファイルに「戻さないこと」と書き残しても、1回の実行で2つとも戻された。再検知は`converged`で、Issueは作られず、戻されたことは実行のログにしか残らなかった
* クラウドでは、作り直しの影響の大きさ、収束に必要な権限、APIの制限、手動変更の経路が加わる。何に戻し、何を戻さず、どこで止まるかは、プロバイダーを問わず同じである

---

[↑ 目次に戻る](#-目次)

---

## 11. 次回予告

本シリーズの **[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** では、環境ごとに最後に適用したコミットのコードで実環境を定期的に比べる検知を作り、結果を「差分なし」「差分あり」「検知失敗」の3つに分けました。第19回となる今回は、**[ドリフトシリーズ第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-04/)** の防ぐ・検知する・修正するのうち、「修正する」を扱いました。収束先を、mainではなく、環境ごとに最後に適用したコミットに限り、検知の時点で保存したplanで、検知した差分だけを戻す自動収束を作りました。作り直し・削除・作成を含む変更と検知失敗は人に返し、承認ゲートと同じ順序と条件で戻すようにしました。収束しないPlaybookは、収束の後の再検知で止まるようにしました。そのうえで、自動収束が直せないものを整理し、障害対応で加えた手動変更まで、自動収束が元に戻してしまうことを確かめました。最後に、この設計がクラウドのプロバイダーでも変わらないことを示しました。

**[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-20/)** では、今回の最後に確かめた、障害対応の手動変更と自動収束の衝突を扱います。今回の自動収束は、障害対応の担当者が意図して加えた変更も、書き残したメモも、ドリフトとして戻しました。Issueにも何も残りませんでした。次回は、障害対応の変更でもGitを経由できる速い経路と、自動収束の一時停止、手で加えた変更を後からGitに取り込むバックポートを、記録と期限を持つ「設計された例外経路」として、パイプラインに組み込みます。

**[次回：第20回：緊急対応の手動変更とGitOpsを両立させる](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-20/)**

---

📑 連載の移動　**[前の記事：【GitOps編】第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)　｜　[次の記事：【GitOps編】第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-20/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第4部まとめブログ：ドリフトの区別・検知・収束・例外・予防を「最後に適用したコミット」でつなぐ** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 12. 連載一覧：「Ansible×TerraformをGitOpsで回す」

### 第4部：ドリフト検知と自動収束

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)**|GitOps環境でドリフトはなぜ起きるのか|ドリフトシリーズの、記述されていない要素は比較の対象にならないというルールが、Ansible・Terraform・GitOpsの3か所で現れることを示す。第1回の3つの経路が第2部・第3部を経ても残ることと、承認・昇格・revertが生む食い違いを整理する。「main」「最後に適用したコミット」「実環境」の3つの状態を区別し、マージ済みで未適用の状態とコンテナの属性の手動変更を実機で作って、未適用の差分とドリフトを記録で見分ける。第4部の初回。|
|**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)**|定期実行でドリフトを自動検知する|環境ごとに「最後に適用したコミット」のコードで実環境を比べ、結果を「差分なし」「差分あり」「検知失敗」の3つに分ける定期検知を作る。stateのロックとの衝突を同時実行のグループとロックの待ち時間で扱い、検知が止まったことをホステッドランナーの確認役から気づけるようにする。結果を環境ごとに1つのIssueに残し、昇格の途中の複数環境でも環境ごとに独立して検知できることを確かめる。Ansible×Terraformシリーズ第37回の深掘り版として位置づける。|
|**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)**|ドリフトを検知したら自動収束させる|収束先をmainではなく環境ごとに最後に適用したコミットに限り、検知の時点で保存したplanで検知した差分だけを戻す自動収束を作る。作り直し・削除・作成と検知失敗は人に返し、ガードレールの結果を確かめてから戻す。収束の後の再検知で、収束しないPlaybookによる繰り返しを止める。自動収束が直せないものを整理し、障害対応の手動変更まで元に戻されることを実機で確かめる。|
|**[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-20/)**|緊急対応の手動変更とGitOpsを両立させる|障害対応で加えた手動変更を自動収束が元に戻してしまう問題を扱う。Gitを経由する高速経路と、自動収束の一時停止・バックポートを、記録と期限を持つ「設計された例外経路」として組み込む。|
|**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)**|検知できないドリフトを減らす：管理対象の範囲を広げる設計|検知も自動収束もできない「記述・記録されていない乖離」を扱い、ドリフトシリーズ第4回の「防ぐ」をGitOps上で実装する。管理外のものを実際の状態とPlaybook・tfstateとの突き合わせで洗い出し、「取り込む」「削除する」「管理外と宣言する」に振り分けてすべてをGitに記録する。第4部・シリーズの最終回。|

---

[↑ 目次に戻る](#-目次)

---