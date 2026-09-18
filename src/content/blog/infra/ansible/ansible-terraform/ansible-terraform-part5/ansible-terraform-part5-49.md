---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第49回：CI/CD環境において再構築事故を物理的に防ぐパイプラインガード'
description: 'terraform planの結果をJSON形式で機械的に解析し、Destroy & Createに相当する危険な変更を検出してapplyを自動的にブロックする、CI/CDパイプライン上のガードレール設計を扱う。prevent_destroyとは異なり、コードの外側に置かれた着脱可能な一時的チェック工程としての性質を整理する。'
pubDate: 2026-09-18
category: 'infra'
tags: ['Ansible', 'Terraform', 'GitHub Actions', 'CI/CD', 'terraform plan']
seriesId: 'ansible-terraform-part5'
seriesNo: 49
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-48/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-50/'
relatedSeries: ''
---


<style> table th, table td { word-break: normal; } table td:first-child { white-space: nowrap; } </style>

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第5部まとめブログ：Terraformライフサイクル破壊編で明らかになった「認識の不可視性」の構造** **※近日公開予定**

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [terraform planの機械可読な出力](#2-terraform-planの機械可読な出力)
3. [危険なactionsパターンの検出](#3-危険なactionsパターンの検出)
4. [GitHub Actions上でのブロック実装](#4-github-actions上でのブロック実装)
5. [誤検知への配慮](#5-誤検知への配慮)
6. [第43回との違いの整理](#6-第43回との違いの整理)
7. [まとめ](#7-まとめ)
8. [次回予告](#8-次回予告)
9. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#9-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

`terraform plan`の出力を注意深く読めば、危険な変更には事前に気づけるはずだ、と考えていないでしょうか。

**[第48回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-48/)** では、実行時にAnsibleで設定変更を加えるという運用そのものを見直し、ビルド時にAnsibleを組み込んでコンテナイメージへ設定を焼き込むイミュータブルな運用への転換を扱いました。この転換により、**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** で確認した、強制再生成によるAnsibleの設定消失は実質的に解消されることを実機で確認しました。

ただし、この転換はあくまで設計上の対策です。`lifecycle`ブロックの設定ミスや、意図しないコード変更によって、リソースの再生成そのものが計画されてしまう可能性自体は残ります。イミュータブル運用への転換は、再生成が起きた場合の被害を軽減する設計であり、再生成の計画そのものを止める仕組みではありません。

第49回となる今回は、この「計画されてしまった危険な変更」を、人間のレビューに頼らず、CI/CDパイプライン側で機械的に検知、阻止する仕組みを扱います。**[第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)** から **[第48回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-48/)** までで扱ってきた問題の多くは、`terraform plan`の出力を注意深く読めば、事前に気づけるものでした。しかし実務では、大量の差分の中でDestroy & Createの行を見落とす、あるいはレビュー自体が形骸化するといった事態が起こり得ます。

この回で扱う問いは、「人間の注意力に頼らず、危険な変更を機械的にブロックする仕組みをどう作るか」です。

次のセクションでは、この仕組みの技術的な土台となる、`terraform plan`の機械可読な出力について整理します。

---

[↑ 目次に戻る](#-目次)

---

## 2. terraform planの機械可読な出力

この回の技術的な土台を整理します。

`terraform plan -out=tfplan`で計画をファイルに保存すると、`terraform show -json tfplan`によって、その計画をJSON形式で取り出せます。ここでは、実際に`docker-lab`環境で危険な変更を発生させ、このJSON出力の構造を確認します。

**実行コマンド**

```plaintext
terraform plan -out=tfplan
```

**▼ 実行結果（該当箇所抜粋）**

```plaintext
Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
-/+ destroy and then create replacement

Terraform will perform the following actions:

  # docker_container.targets["target-node1"] will be replaced due to changes in replace_triggered_by
（途中省略：属性の差分詳細）

  # docker_container.targets["target-node2"] will be replaced due to changes in replace_triggered_by
（途中省略：属性の差分詳細）

  # docker_container.targets["target-node3"] will be replaced due to changes in replace_triggered_by
（途中省略：属性の差分詳細）

（途中省略：local_file、tls_private_keyの再作成計画）

Plan: 7 to add, 0 to change, 7 to destroy.

（途中省略：Changes to Outputs）

Saved the plan to: tfplan

To perform exactly these actions, run the following command to apply:
    terraform apply "tfplan"
```

`tls_private_key.generated`を意図的にtaintしたうえで`terraform plan`を実行しており、target-node1〜3の3台すべてに`will be replaced due to changes in replace_triggered_by`という計画が立てられています。この構造自体は、`replace_triggered_by`によってfor_each一括生成のリソースが連鎖的に再生成される現象であり、実機環境ではすでに何度も確認してきた挙動です。

続けて、この保存済みの計画をJSON形式に変換します。

**実行コマンド**

```plaintext
terraform show -json tfplan > plan.json
```

このコマンドに、目に見える実行結果はありません。`plan.json`というファイルに、計画の全内容がJSON形式で書き出されます。

`plan.json`の中身は、`resource_changes`という配列を中心に構成されています。この配列の要素1つが、1つのリソースに対応する変更計画です。target-node1に対応する要素を、`jq`を使って抽出します。

**実行コマンド**

```plaintext
jq '.resource_changes[] | select(.address == "docker_container.targets[\"target-node1\"]") | {address, actions: .change.actions}' plan.json
```

**▼ 実行結果**

```plaintext
{
  "address": "docker_container.targets[\"target-node1\"]",
  "actions": [
    "delete",
    "create"
  ]
}
```

### ■ 結果

`address`には、`docker_container.targets["target-node1"]`という、`terraform plan`の見出しに表示されていたのと同じリソースアドレスがそのまま入っています。`actions`には`["delete", "create"]`という2つの文字列が並んだ配列が入っており、これが`terraform plan`の出力で見た`-/+ destroy and then create replacement`という表示に対応する、機械可読な形式です。

`actions`に入り得る値は、この`["delete", "create"]`（破棄してから作成、つまりDestroy & Create）のほかに、単純な新規作成であれば`["create"]`、属性の直接更新であれば`["update"]`、変更なしであれば`["no-op"]`といった組み合わせがあります。人間が`terraform plan`の出力を目視で読み、`-/+`という記号や`will be replaced`という文言からDestroy & Createを判別していた作業が、`plan.json`では`actions`という配列の中身を見るだけの、単純な値の比較に置き換わっていることが確認できます。

次のセクションでは、この`actions`の値をもとに、危険なパターンを機械的に検出する具体的な処理を扱います。

---

[↑ 目次に戻る](#-目次)

---

## 3. 危険なactionsパターンの検出

**[セクション2](#2-terraform-planの機械可読な出力)** で確認した`actions`の値をもとに、危険なパターンを機械的に検出する処理を整理します。

まず、`plan.json`全体を対象に、`actions`が`["delete", "create"]`となっているリソースの件数を確認します。

**実行コマンド**

```plaintext
jq '[.resource_changes[] | select(.change.actions == ["delete","create"])] | length' plan.json
```

**▼ 実行結果**

```plaintext
7
```

**[セクション2](#2-terraform-planの機械可読な出力)** で確認した`Plan: 7 to add, 0 to change, 7 to destroy.`と一致する件数です。続けて、該当するリソースのアドレスを一覧で確認します。

**実行コマンド**

```plaintext
jq '.resource_changes[] | select(.change.actions == ["delete","create"]) | .address' plan.json
```

**▼ 実行結果**

```plaintext
"docker_container.targets[\"target-node1\"]"
"docker_container.targets[\"target-node2\"]"
"docker_container.targets[\"target-node3\"]"
"local_file.ansible_inventory"
"local_file.group_vars_target_nodes"
"local_file.private_key"
"tls_private_key.generated"
```

### ■ 結果：`actions`だけでは絞り込みが粗い

`docker_container.targets`のtarget-node1〜3に加えて、`local_file.ansible_inventory`・`local_file.group_vars_target_nodes`・`local_file.private_key`・`tls_private_key.generated`まで、7件すべてが`["delete", "create"]`として検出されました。

`replace_triggered_by`による再生成は、`tls_private_key.generated`という1つのリソースの再生成が起点になっています。この起点となったリソース自体と、そこから派生する`local_file`群も、`docker_container`と同じくDestroy & Createとして計画されるため、`actions`の値だけを条件にすると、これらすべてが危険パターンとして一括で引っかかります。しかし、`local_file`や`tls_private_key`が再生成されても、稼働中のコンテナが失われるわけではありません。この回で本来警戒すべきなのは、Ansibleが投じた設定やデータを保持している`docker_container`のほうです。

### ■ 検証内容：リソースタイプによる絞り込み

`plan.json`の各要素は、`address`や`change.actions`のほかに`type`というフィールドを持っています。この`type`を条件に加え、`docker_container`だけに絞り込みます。

**実行コマンド**

```plaintext
jq '.resource_changes[] | select(.change.actions == ["delete","create"] and .type == "docker_container") | .address' plan.json
```

**▼ 実行結果**

```plaintext
"docker_container.targets[\"target-node1\"]"
"docker_container.targets[\"target-node2\"]"
"docker_container.targets[\"target-node3\"]"
```

### ■ 結果

`type == "docker_container"`という条件を加えることで、target-node1〜3の3件だけに絞り込めることが確認できました。`local_file`や`tls_private_key`は`type`の値がそれぞれ`local_file`・`tls_private_key`であり、この条件には一致しません。

`actions`は「何が起きるか（破棄してから作成されるか）」を示す情報であり、`type`は「何に対して起きるか（どのリソース種別か）」を示す情報です。この2つを組み合わせることで、「破棄と作成が組になって計画されている、かつ、それがコンテナである」という、この回で検出したい条件を機械的に表現できます。

次のセクションでは、この検出処理をGitHub Actions上のワークフローに組み込む方法を扱います。

---

[↑ 目次に戻る](#-目次)

---

## 4. GitHub Actions上でのブロック実装

**[セクション2](#2-terraform-planの機械可読な出力)**・**[セクション3](#3-危険なactionsパターンの検出)** で確認した検出処理を、実際のGitHub Actionsワークフローに組み込みます。

**[第32回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/)** でGitHub Actions上で使用するために構築した`.github/workflows/e2e-provisioning-test.yml`には、その後の回の検証を経て、`terraform apply`によるコンテナ起動からAnsible適用、Testinfraによる状態検証までの一連のステップがすでに存在しています。このファイルの現状を`cat -n`で確認します。

**実行コマンド**

```plaintext
cat -n .github/workflows/e2e-provisioning-test.yml
```

**▼ 実行結果**

```plaintext
     1  name: E2E Provisioning Test
     2
     3  on:
     4    workflow_dispatch:
     5
     6  jobs:
     7    e2e-test:
     8      runs-on: ubuntu-latest
     9      steps:
    10        - uses: actions/checkout@v4
    11        - name: Check Docker availability
    12          run: docker version
    13        - uses: hashicorp/setup-terraform@v3
    14        - name: Terraform Init
    15          run: terraform init
    16        - name: Terraform Apply
    17          env:
    18            TF_VAR_ansible_user_password: ${{ secrets.TF_VAR_ANSIBLE_USER_PASSWORD }}
    19            TF_VAR_deploy_user_password: ${{ secrets.TF_VAR_DEPLOY_USER_PASSWORD }}
    20          run: terraform apply -auto-approve
（途中省略：Export inventory、Ansible適用、Testinfra関連のステップ、21〜48行目）
    49        - name: Trigger destroy-and-recreate (verification)
    50          run: terraform taint tls_private_key.generated
    51        - name: Terraform Plan
    52          env:
    53            TF_VAR_ansible_user_password: ${{ secrets.TF_VAR_ANSIBLE_USER_PASSWORD }}
    54            TF_VAR_deploy_user_password: ${{ secrets.TF_VAR_DEPLOY_USER_PASSWORD }}
    55          run: terraform plan -out=tfplan
    56        - name: Export plan as JSON
    57          run: terraform show -json tfplan > plan.json
    58        - name: Check for dangerous destroy-and-create actions
    59          run: |
    60            DANGEROUS=$(jq '[.resource_changes[] | select(.change.actions == ["delete","create"] and .type == "docker_container")] | length' plan.json)
    61            if [ "$DANGEROUS" -gt 0 ]; then
    62              echo "danger detected: $DANGEROUS docker_container resource(s) planned for destroy-and-create"
    63              jq '.resource_changes[] | select(.change.actions == ["delete","create"] and .type == "docker_container") | .address' plan.json
    64              exit 1
    65            fi
    66            echo "no dangerous destroy-and-create pattern detected"
```

49〜66行目が、この回で新たに追加した部分です。**[セクション2](#2-terraform-planの機械可読な出力)**・**[セクション3](#3-危険なactionsパターンの検出)** で確認した検出処理を、実際にワークフローへ組み込んでいます。`Trigger destroy-and-recreate (verification)`（49〜50行目）は、この回の検証のために意図的に危険な変更を発生させるステップです。実務ではこのステップは存在せず、コード変更それ自体が`replace_triggered_by`の条件を満たすことで、同じ状況が発生します。`Terraform Plan`（51〜55行目）には、16〜19行目の`Terraform Apply`ステップと同様、GitHub Secretsから`TF_VAR_ansible_user_password`等を受け渡す`env`ブロックが必要です。

このワークフローを、GitHub Actionsの手動トリガー（`workflow_dispatch`）で実行します。

### ■ 検証内容：1回目のterraform applyによるリソース作成

**▼ 実行結果（GitHub Actionsの「Terraform Apply」、該当箇所抜粋）**

```plaintext
Run terraform apply -auto-approve

Terraform used the selected providers to generate the following execution
plan. Resource actions are indicated with the following symbols:
  + create

Terraform will perform the following actions:

  # docker_container.targets["target-node1"] will be created
  + resource "docker_container" "targets" {
（途中省略：target-node1〜3、docker_image、docker_network、local_file等の作成計画詳細）
    }

Plan: 14 to add, 0 to change, 0 to destroy.

（途中省略：Changes to Outputs、各リソースのCreating...ログ）

docker_container.targets["target-node1"]: Creation complete after 1s [id=64eb9d984a2d281e4c57972f9b3ebf89fb74ea95b32d03b97a3b5ab2f1afae8a]
docker_container.targets["target-node3"]: Creation complete after 1s [id=285f88b142a5566139742c0da895f6f3d058a1c5e99fc24d031f7fe9a84c21a2]
docker_container.targets["target-node2"]: Creation complete after 1s [id=2d7d74b05a97d0739fe51a84122346f47c8bf392d849b6eed8f6ad003ec34dfc]

（途中省略：local_fileの作成完了ログ、docker_image.***_target_legacyの作成完了ログ）

Apply complete! Resources: 14 added, 0 changed, 0 destroyed.
```

target-node1〜3を含む14リソースがすべて正常に作成されました。**[第32回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/)** で確認した通り、CI環境は毎回ゼロの状態からリソースを作成するため、ローカル環境の再作成（IPが`172.19.0.2`等に変わる挙動）とは別に、CI環境固有のIPアドレスが払い出されています。

### ■ 検証内容：危険な変更の発生

続けて、GitHub Actionsの「Trigger destroy-and-recreate (verification)」ステップが実行されます。

**▼ 実行結果（GitHub Actionsの「Trigger destroy-and-recreate (verification)」）**

```plaintext
Run terraform taint tls_private_key.generated
Resource instance tls_private_key.generated has been marked as tainted.
```

### ■ 検証内容：terraform planによる危険パターンの計画

**▼ 実行結果（GitHub Actionsの「Terraform Plan」、該当箇所抜粋）**

```plaintext
Run terraform plan -out=tfplan
（途中省略：Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution
plan. Resource actions are indicated with the following symbols:
-/+ destroy and then create replacement

Terraform will perform the following actions:

  # docker_container.targets["target-node1"] must be replaced
-/+ resource "docker_container" "targets" {
（途中省略：属性の差分詳細）
    }

  # docker_container.targets["target-node2"] must be replaced
（途中省略：属性の差分詳細）

  # docker_container.targets["target-node3"] must be replaced
（途中省略：属性の差分詳細）

（途中省略：local_file、tls_private_keyの再作成計画）

Plan: 7 to add, 0 to change, 7 to destroy.

（途中省略：Changes to Outputs）

Saved the plan to: tfplan

To perform exactly these actions, run the following command to apply:
    terraform apply "tfplan"
```

GitHub Actionsの「Terraform Plan」ステップは、`env`ブロックによる変数の受け渡しを追加したことで、対話プロンプトで止まることなく実行が完了しています。target-node1〜3の3台すべてに`must be replaced`が計画され、`Plan: 7 to add, 0 to change, 7 to destroy`という結果は、**[セクション2](#2-terraform-planの機械可読な出力)** でローカル環境から確認した構造と一致しています。

### ■ 検証内容：JSON化と危険パターンの検出、ジョブの失敗

**▼ 実行結果（GitHub Actionsの「Export plan as JSON」）**

```plaintext
Run terraform show -json tfplan > plan.json
```

このステップに目に見える出力はなく、`plan.json`が生成されるのみです。続けて、GitHub Actionsの「Check for dangerous destroy-and-create actions」ステップが実行されます。

**▼ 実行結果（GitHub Actionsの「Check for dangerous destroy-and-create actions」）**

```plaintext
Run DANGEROUS=$(jq '[.resource_changes[] | select(.change.actions == ["delete","create"] and .type == "docker_container")] | length' plan.json)
danger detected: 3 docker_container resource(s) planned for destroy-and-create
"docker_container.targets[\"target-node1\"]"
"docker_container.targets[\"target-node2\"]"
"docker_container.targets[\"target-node3\"]"
Error: Process completed with exit code 1.
```

### ■ 結果

`danger detected: 3 docker_container resource(s) planned for destroy-and-create`というメッセージとともに、target-node1〜3の3件のリソースアドレスが出力され、`Error: Process completed with exit code 1.`としてジョブ全体が失敗しました。

このワークフローには、危険パターンが検出されなかった場合に進むはずの2回目の`terraform apply`ステップを、意図的に用意していません。**[セクション3](#3-危険なactionsパターンの検出)** で確立した検出条件（`actions == ["delete","create"]`かつ`type == "docker_container"`）に該当するリソースが1件でもあれば、この時点でジョブが停止し、それ以降のいかなるステップにも進みません。人間がこの`terraform plan`の出力を目視で確認しなくても、`apply`の実行そのものが機械的にブロックされることが、CI環境上で実機確認できました。

次のセクションでは、この検出条件を一律に適用した場合に生じる、誤検知の問題を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 5. 誤検知への配慮

このガードを実運用に組み込む際に注意すべき、誤検知への配慮を整理します。

### ■ actionsだけでは対象が広すぎる

**[セクション3](#3-危険なactionsパターンの検出)** で確認した通り、`actions == ["delete", "create"]`という条件だけで検出すると、`docker_container.targets`のtarget-node1〜3だけでなく、`local_file.ansible_inventory`・`local_file.group_vars_target_nodes`・`local_file.private_key`・`tls_private_key.generated`までが一律で該当しました。これらは`replace_triggered_by`の起点となった`tls_private_key.generated`の再生成に連動して再生成されるリソースであり、再生成されても稼働中のコンテナが失われるわけではありません。

このガードで本来止めたいのは、Ansibleが設定した稼働中のコンテナが失われる変更です。**[セクション3](#3-危険なactionsパターンの検出)** で確認した`type == "docker_container"`という条件を加えることで、target-node1〜3の3件だけに絞り込めることはすでに実機で確認済みです。`local_file`や`tls_private_key`の再生成まで一律にブロックしてしまうと、このガード自体が過剰な誤検知を起こす仕組みになりかねません。

### ■ target-node1〜3を一律に対象とする理由

`docker_container`という条件だけでは、target-node1〜3のうち、特定のノードだけをより厳格に扱う、という絞り込みも考えられます。たとえば、**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)** で確認した通り、この検証環境でステートフルなデータ（`records.db`）が投入されているのはtarget-node1のみであり、target-node2・3にはそうしたデータはありません。

しかし、**[第47回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/)** でVolumeによるデータの分離を導入して以降、target-node1のデータはコンテナの再生成そのものからは切り離されています。また、**[第48回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-48/)** でイミュータブル運用へ転換して以降、Ansibleが投じる設定はコンテナではなくイメージに焼き込まれており、target-node1・2・3のいずれが再生成されても、意図しない再生成そのものを検知する価値は変わりません。したがって、このガードでは、データの有無によってtarget-node群をさらに絞り込むことはせず、`docker_container`という条件のもとで、target-node1〜3を一律に警戒対象とします。

### ■ 完全ブロックではなく一段階の確認を強制する

**[セクション4](#4-github-actions上でのブロック実装)** で実機確認した構成は、危険パターンが検出された時点でジョブそのものを失敗させ、`apply`には一切進めない、という完全ブロックの形でした。しかし、実運用では、イメージの更新等、意図的な再生成が計画されるケースも当然あります。このような場合にまでジョブを失敗させ続けると、正当な変更のたびに手動でガードを無効化する、という運用が常態化しかねません。

これに対する設計上の選択肢として、GitHub Actionsには、特定のジョブの実行前に必須レビュアーの承認を求める、Environmentsという仕組みが用意されています。危険パターンが検出された場合、`apply`を実行するジョブにこのEnvironmentを紐付けておけば、ジョブは自動的に失敗するのではなく、承認が下りるまで一時停止した状態になります。レビュアーが内容を確認し、意図した変更であると判断すれば、そのままジョブを再開できます。

ここでは、完全ブロックと放置の中間にあたる、こうした選択肢が存在するということを整理するにとどめます。次のセクションでは、この「一段階の確認を強制する」という性質が、**[第43回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-43/)** で扱った`prevent_destroy`とどう異なるかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 6. 第43回との違いの整理

**[セクション5](#5-誤検知への配慮)** で触れた「一段階の確認を強制する」という性質が、**[第43回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-43/)** で扱った`prevent_destroy`とどう異なるかを整理します。

**[第43回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-43/)** では、`lifecycle`ブロックに`prevent_destroy = true`を設定すると、そのリソースを破棄する計画が`terraform plan`・`apply`の時点でエラーとして拒否されることを実機で確認しました。この拒否は一律で無条件であり、意図しない誤破壊と、ベースイメージの更新等による意図した再構築の要求を区別しません。解除するには、`main.tf`から`prevent_destroy`の記述そのものを削除する必要があることも、**[第43回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-43/)** で実機確認済みです。

この回で構築したガードは、これとは異なる3つの点を持っています。

|項目|`prevent_destroy`（[第43回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-43/)）|パイプラインガード（この回）|
|---|---|---|
|実装場所|Terraformコード（`lifecycle`ブロック）|CI/CDワークフロー（`terraform plan`のJSON解析）|
|拒否の性質|恒久的、無条件|検出のたびにジョブが失敗する、都度のチェック|
|解除方法|コード変更（`lifecycle`設定の削除）|危険パターンが解消されれば自動的に通過する|

**[セクション4](#4-github-actions上でのブロック実装)** で実機確認した通り、この回のガードは、危険パターンを検出した時点でジョブそのものを失敗させる構成です。`prevent_destroy`のように`main.tf`に恒久的な制約を書き込むのではなく、CI/CDワークフロー側の1つのステップとして存在しているため、このステップ自体を除外すれば、ガードなしの状態にいつでも戻せます。この「コードの外側に置かれた、着脱可能なチェック工程である」という点が、`prevent_destroy`との構造上の違いです。

さらに、**[セクション5](#5-誤検知への配慮)** で整理した通り、このガードはGitHub ActionsのEnvironmentsと組み合わせることで、検出時にジョブを即座に失敗させるのではなく、承認を経て通過させるという拡張も可能です。`prevent_destroy`は、コードを変更しない限り一切の破棄を受け付けませんが、このガードは、都度の判断を人間に委ねる余地を持った、緩やかな制約として設計できます。

いずれの仕組みも、Ansibleが投じた設定やデータの消失を防ぐという目的は共通しています。しかし、`prevent_destroy`が「破棄そのものを起こさせない」という設計であるのに対し、この回のガードは「破棄が計画された事実を、実行前に人間の目に必ず触れさせる」という設計です。次のセクションでは、この回で整理した内容をまとめます。

---

[↑ 目次に戻る](#-目次)

---


## 7. まとめ

この回で整理した内容を確認します。

* `terraform plan -out=tfplan`で計画を保存し、`terraform show -json tfplan`でJSON形式の差分情報を取得できることを実機で確認した。この出力の`resource_changes`配列にはリソースごとの`change.actions`が含まれており、`["delete", "create"]`という値がDestroy & Createに相当することを、実際に`replace_triggered_by`による再生成を発生させて確認した
* `actions == ["delete", "create"]`という条件だけでは、`docker_container.targets`だけでなく`local_file`や`tls_private_key`まで一律に検出されてしまうことを実機で確認した。`type == "docker_container"`という条件を加えることで、target-node1〜3の3件だけに絞り込めることを、`jq`による実機検証で確認した
* GitHub Actionsのワークフローに、`terraform plan`の実行、JSON化、危険パターンの検出という一連のステップを追加し、危険パターンが検出された場合はジョブそのものを失敗させ、`apply`ステップに進ませない構成を実機で確認した。CI上で実際に`danger detected: 3 docker_container resource(s) planned for destroy-and-create`という出力とともにジョブが失敗する様子を確認できた
* このガードは、`docker_container`という条件のもとでtarget-node1〜3を一律に警戒対象とする設計とした。**[第47回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/)** のVolume導入、**[第48回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-48/)** のイミュータブル運用への転換により、データの有無によってノードを絞り込む必要性は薄れているためである
* このガードは、危険パターンを検出するたびにジョブを失敗させる、一時的なチェック工程として実装した。GitHub ActionsのEnvironmentsと組み合わせることで、検出時に即座に失敗させるのではなく、承認を経て通過させるという拡張も可能であることを整理した
* **[第43回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-43/)** の`prevent_destroy`が、コードに組み込む恒久的、無条件の制約であるのに対し、この回のガードはCI/CDワークフロー側の着脱可能なチェック工程である。`prevent_destroy`が「破棄そのものを起こさせない」設計であるのに対し、このガードは「破棄が計画された事実を、実行前に人間の目に必ず触れさせる」設計である

---

[↑ 目次に戻る](#-目次)

---

## 8. 次回予告

第49回となる今回は、**[第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)** から **[第48回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-48/)** までで扱ってきた「起きてしまった問題にどう対処するか」「起きないように設計するか」という視点から、「起きる前に機械的に止める」という視点に移りました。`terraform plan`の結果をJSON形式で機械的に解析し、Destroy & Createに相当する危険な変更を検出してGitHub Actions上で`apply`を自動的にブロックする仕組みを、CI環境で実機構築、検証しました。`actions`と`type`を組み合わせた検出条件の設計、誤検知への配慮、そして **[第43回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-43/)** の`prevent_destroy`との違いを、それぞれ整理しました。

**[第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)** から今回まで、TerraformとAnsibleの「認識の不可視性」という根本構造から出発し、強制再生成による設定消失、`prevent_destroy`との衝突、データの全喪失、連鎖的再生成、State不整合、Volumeによるデータの分離、イミュータブル運用への転換、そしてCI/CDパイプラインによる事前ブロックと、Terraformのライフサイクル操作がAnsibleの設定にどう影響し、それにどう向き合うかを、さまざまな角度から実機で確認してきました。

次回は、第5部および全50回を通じて積み上げてきた知見を総括し、Terraformにどこまでを任せ、Ansibleにどこから委ねるかという「ツール境界線」の設計原則としてまとめます。

**[次回：第50回：連載総括：Ansible×Terraformを共存させる「ツール境界線」の設計原則](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-50/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第48回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-48/)　｜　[次の記事：【Ansible×Terraform編】第50回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-50/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第5部まとめブログ：Terraformライフサイクル破壊編で明らかになった「認識の不可視性」の構造** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 9. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

### 第5部：Terraformライフサイクル破壊編

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)**|なぜTerraformはAnsibleが投じた設定を知らないのか|TerraformのState管理メカニズムと、Ansibleが変更するコンテナ内部状態の「認識の不可視性」を解剖する根本解説回。|
|**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)**|`create_before_destroy`や`replace_triggered_by`による強制再生成|HCLのライフサイクル制御（`lifecycle`ブロック）によって強制再生成（ForceNew）が発生し、Ansibleの設定が消し飛ぶ現象の再現。|
|**[第43回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-43/)**|`prevent_destroy`設定時におけるAnsibleプロビジョニングの詰まり|誤破壊防止の`prevent_destroy`と、Ansibleの再実行（再プロビジョニング）要求がバッティングしてデプロイが詰まる障害。|
|**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)**|リソース再生成に伴うAnsible生成データの全喪失（データ消失障害）|Terraform側がリソースを破棄、再生成（Destroy & Create）した際、Ansibleで作成したデータベースやファイルなどの状態が全消去される問題。|
|**[第45回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-45/)**|ネットワークや依存リソースの変更に引きずられる連鎖的再生成|依存関係にあるネットワーク（Docker Network）や上位リソースの変更により、ターゲット全体が連鎖破壊される現象。|
|**[第46回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-46/)**|プロビジョニング途中の接続切断とState不整合（ハーフデプロイ状態）|Ansible実行中に接続が切断、エラー停止した際、TerraformのStateが「作成完了」と「プロビジョニング未完了」の半端な状態になる問題。|
|**[第47回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/)**|ステートフルなデータ（Volume/DB）を保持しながらの安全な再構築|内部データをDocker Volumeに分離し、コンテナ（リソース）が再生成されてもAnsibleの投入データを生かす設計。|
|**[第48回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-48/)**|イミュータブルインフラストラクチャにおけるAnsibleの限定的役割|「実行時にAnsibleで設定する」のを取りやめ、ビルド時にAnsibleを組み込んでコンテナイメージを焼き込む運用へのシフト。|
|**[第49回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-49/)**|CI/CD環境において再構築事故を物理的に防ぐパイプラインガード|GitHub Actions等で誤ってDestroy & Createが走らないよう、`terraform plan`の差分ログを解析して自動ブロックするガードレール設計。|
|**[第50回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-50/)**|連載総括：Ansible×Terraformを共存させる「ツール境界線」の設計原則|50回を通じた結論。「どこまでをTerraformに任せ、どこからをAnsibleに委ねるか」の境界線（アンチパターンと原則）のまとめ。|

---

[↑ 目次に戻る](#-目次)

---