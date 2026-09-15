---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第43回：`prevent_destroy`設定時におけるAnsibleプロビジョニングの詰まり'
description: '誤破壊防止のための`prevent_destroy`設定が、リソースの破棄を伴う変更と衝突した際に`terraform apply`がエラーで停止し、デプロイパイプラインが詰まる構造を整理する。第42回の設定消失を防ぐ目的で`prevent_destroy`を設定すると、別の障害に置き換わるだけであることを実機で確認する。'
pubDate: 2026-09-15
category: 'infra'
tags: ['Ansible', 'Terraform', 'lifecycle', 'prevent_destroy', 'replace_triggered_by']
seriesId: 'ansible-terraform-part5'
seriesNo: 43
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/'
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
2. [`prevent_destroy`の仕組み](#2-prevent_destroyの仕組み)
3. [第42回の再生成条件との衝突](#3-第42回の再生成条件との衝突)
4. [Ansible側の再プロビジョニング要求との衝突](#4-ansible側の再プロビジョニング要求との衝突)
5. [詰まりの実際の挙動](#5-詰まりの実際の挙動)
6. [まとめ](#6-まとめ)
7. [次回予告](#7-次回予告)
8. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#8-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

Ansibleが投じた設定を守るために、破棄そのものを禁止すればよいのではないか、と考えたことはないでしょうか。

**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** では、`create_before_destroy`・`replace_triggered_by`によってリソースが強制的に再生成され、Ansibleが投じた設定が消失する現象を実機で確認しました。その対策として直感的に思いつくのが、再生成そのものを禁止するというアプローチです。

第43回となる今回は、この`prevent_destroy`という設定を検証します。`prevent_destroy`はリソースの破棄を伴う変更を`lifecycle`ブロック上で拒否させる設定であり、一見すると **[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** で確認した消失を防げるように見えます。しかし、この設定は消失を防ぐ代わりに、別の種類の障害を引き起こします。この回の目的は、その障害の構造を整理することです。

次のセクションでは、`prevent_destroy`が何を制御しているかを実機で確認します。

---

[↑ 目次に戻る](#-目次)

---

## 2. `prevent_destroy`の仕組み

`prevent_destroy`が何を制御しているかを実機で確認します。

`lifecycle`ブロックに`prevent_destroy = true`を設定すると、そのリソースを破棄する計画が`terraform plan`・`apply`の時点でエラーとして拒否されます。

### ■ 検証内容

target-node1の`lifecycle`ブロックに`prevent_destroy = true`を追加します。

* **ファイル名：`main.tf`（該当箇所）**

**【変更前】**

```hcl
  lifecycle {
    ignore_changes = [network_mode]
  }
```

**【変更後】**

```hcl
  lifecycle {
    prevent_destroy = true
    ignore_changes = [network_mode]
  }
```

この状態で、target-node1のみを対象に`terraform destroy`を実行します。

**実行コマンド**

```plaintext
terraform destroy -target='docker_container.targets["target-node1"]'
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  - destroy

Terraform planned the following actions, but then encountered a problem:

（途中省略：破棄対象リソースの属性一覧）

Plan: 0 to add, 0 to change, 4 to destroy.
╷
│ Warning: Resource targeting is in effect
│
│ You are creating a plan with the -target option, which means that the result of this plan may not represent all of the changes requested by the current configuration.
│
│ The -target option is not for routine use, and is provided only for exceptional situations such as recovering from errors or mistakes, or when Terraform specifically suggests to use it
│ as part of an error message.
╵
╷
│ Error: Instance cannot be destroyed
│
│   on main.tf line 82:
│   82: resource "docker_container" "targets" {
│
│ Resource docker_container.targets["target-node1"] has lifecycle.prevent_destroy set, but the plan calls for this resource to be destroyed. To avoid this error and continue with the plan,
│ either disable lifecycle.prevent_destroy or reduce the scope of the plan using the -target option.
╵
```

### ■ 結果

`Error: Instance cannot be destroyed`というエラーメッセージとともに、`terraform destroy`が拒否されました。エラーメッセージは、`docker_container.targets["target-node1"]`に`lifecycle.prevent_destroy`が設定されている状態で破棄が計画されたことを明示しており、対処法として`prevent_destroy`の無効化、または`-target`によるスコープ縮小を提示しています。

なお、`Warning: Resource targeting is in effect`は`-target`オプション使用時に一般的に出力される注意書きであり、`prevent_destroy`の挙動そのものとは別の要素です。

この設定は、更新可能な属性の変更には影響しません。影響が出るのは、破棄を伴う変更（削除、再生成）が計画された場合に限られます。次のセクションでは、この`prevent_destroy`が、**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** で確認した再生成条件と組み合わさった場合の挙動を確認します。

---

[↑ 目次に戻る](#-目次)

---

## 3. 第42回の再生成条件との衝突

**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** で扱った再生成パターンと`prevent_destroy`が組み合わさった場合の挙動を確認します。

**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** のセクション4で確認した`replace_triggered_by`の条件を満たす変更が発生した状況で`prevent_destroy`を設定していた場合、再生成そのものがブロックされ、`terraform apply`がエラー終了することを確認します。

### ■ 検証内容

target-node1の`lifecycle`ブロックに`replace_triggered_by = [tls_private_key.generated]`を追加します。

* **ファイル名：`main.tf`（該当箇所）**

**【変更前】**

```hcl
  lifecycle {
    prevent_destroy = true
    ignore_changes  = [network_mode]
  }
```

**【変更後】**

```hcl
  lifecycle {
    prevent_destroy       = true
    replace_triggered_by  = [tls_private_key.generated]
    ignore_changes         = [network_mode]
  }
```

`replace_triggered_by`の条件を満たすため、`tls_private_key.generated`を意図的にtaintします。

**実行コマンド**

```plaintext
terraform taint tls_private_key.generated
```

**▼ 実行結果**

```plaintext
Resource instance tls_private_key.generated has been marked as tainted.
```

この状態で`terraform apply`を実行します。

**実行コマンド**

```plaintext
terraform apply
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
-/+ destroy and then create replacement

Terraform planned the following actions, but then encountered a problem:

  # docker_container.targets["target-node1"] will be replaced due to changes in replace_triggered_by
（途中省略：属性の差分詳細）

  # docker_container.targets["target-node2"] will be replaced due to changes in replace_triggered_by
（途中省略：属性の差分詳細）

  # docker_container.targets["target-node3"] will be replaced due to changes in replace_triggered_by
（途中省略：属性の差分詳細）

  # local_file.private_key must be replaced
（途中省略：属性の差分詳細）

  # tls_private_key.generated is tainted, so must be replaced
（途中省略：属性の差分詳細）

Plan: 5 to add, 0 to change, 5 to destroy.

Error: Instance cannot be destroyed

  on main.tf line 82:
  82: resource "docker_container" "targets" {

Resource docker_container.targets["target-node3"] has lifecycle.prevent_destroy set, but the plan calls for this resource to be destroyed. To avoid this error and continue with the plan,
either disable lifecycle.prevent_destroy or reduce the scope of the plan using the -target option.

Error: Instance cannot be destroyed

  on main.tf line 82:
  82: resource "docker_container" "targets" {

Resource docker_container.targets["target-node1"] has lifecycle.prevent_destroy set, but the plan calls for this resource to be destroyed. To avoid this error and continue with the plan,
either disable lifecycle.prevent_destroy or reduce the scope of the plan using the -target option.

Error: Instance cannot be destroyed

  on main.tf line 82:
  82: resource "docker_container" "targets" {

Resource docker_container.targets["target-node2"] has lifecycle.prevent_destroy set, but the plan calls for this resource to be destroyed. To avoid this error and continue with the plan,
either disable lifecycle.prevent_destroy or reduce the scope of the plan using the -target option.
```

### ■ 結果

`docker_container.targets["target-node1"]`・`["target-node2"]`・`["target-node3"]`のすべてに`will be replaced due to changes in replace_triggered_by`という計画が立てられ、続けて3台分の`Error: Instance cannot be destroyed`が出力されました。`terraform apply`は確認プロンプトに到達する前にエラー終了しており、コンテナ、秘密鍵とも実際には作成、破棄されていません。

`lifecycle`ブロックは`docker_container.targets`が`for_each`によって一括生成されているため、インスタンスごとに個別指定できません。**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** のセクション4では、この制約により`replace_triggered_by`の影響範囲が意図した1台にとどまらず全インスタンスに及ぶことを確認しました。今回、`prevent_destroy`も同じ制約の対象であるため、`replace_triggered_by`の条件を満たした3台すべてに`prevent_destroy`が同時に作用し、3台分のエラーが一括で発生しています。

再生成もAnsibleの再実行も行われないまま、`terraform apply`そのものが処理を進められない状態になりました。次のセクションでは、この詰まりが運用上どのような場面で起きるかを整理します。

---

[↑ 目次に戻る](#-目次)

---


## 4. Ansible側の再プロビジョニング要求との衝突

運用上の必要性と`prevent_destroy`がかみ合わなくなる場面を整理します。

ベースイメージの更新等、運用上リソースの再作成が必要になる場面は現実にあります。**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** で確認した通り、`docker_container`の`name`属性のような更新不可の属性変更や、`replace_triggered_by`のような明示的なトリガーは、いずれもコード変更を起点として発生します。運用上、こうした変更を加えて`terraform apply`を実行する行為は、Ansible側から見れば「新しいリソースを用意してほしい」という再プロビジョニングの要求に相当します。

しかし、セクション3で確認した通り、`prevent_destroy`が設定されている状態でこの要求を出しても、Terraform側はそれを実行できません。
```

【通常時】  
コード変更 → terraform apply → 再生成 → Ansible再実行  
　→ 一連の流れが完結する

【prevent_destroy設定時】  
コード変更 → terraform apply → エラーで停止  
　→ 再生成もAnsible再実行も行われない

```

`prevent_destroy`は、破棄を伴う変更を一律で拒否する設定です。この設定は、意図しない誤破壊を防ぐと同時に、意図した再構築の要求も区別なく拒否します。次のセクションでは、この詰まりが実務上どのような形で現れるかを整理します。


---

[↑ 目次に戻る](#-目次)

---

## 5. 詰まりの実際の挙動

「詰まり」が実務上どのような形で現れるかを整理します。

セクション3で確認した通り、`terraform apply`は確認プロンプトに到達する前にエラーメッセージで停止します。CI/CDパイプラインを組んでいる場合、この時点でパイプライン全体が止まります。手動での`lifecycle`変更、再実行が必要になり、自動化の流れが分断されます。

ここでは`prevent_destroy`を外して対処する具体的な運用手順には深入りせず、詰まりが解消される際の挙動を実機で確認するにとどめます。データを保持したまま安全に再構築する設計は **[第47回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/)** に譲ります。

### ■ 検証内容

セクション3で詰まった状態から、`prevent_destroy`を`main.tf`から削除します。

* **ファイル名：`main.tf`（該当箇所）**

**【変更前】**

```hcl
  lifecycle {
    prevent_destroy       = true
    replace_triggered_by  = [tls_private_key.generated]
    ignore_changes         = [network_mode]
  }
```

**【変更後】**

```hcl
  lifecycle {
    replace_triggered_by  = [tls_private_key.generated]
    ignore_changes         = [network_mode]
  }
```

`tls_private_key.generated`はセクション3でtaint済みのままの状態で、`terraform apply`を実行します。

**実行コマンド**

```plaintext
terraform apply
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
-/+ destroy and then create replacement

Terraform will perform the following actions:

  # docker_container.targets["target-node1"] will be replaced due to changes in replace_triggered_by
（途中省略：属性の差分詳細）

  # docker_container.targets["target-node2"] will be replaced due to changes in replace_triggered_by
（途中省略：属性の差分詳細）

  # docker_container.targets["target-node3"] will be replaced due to changes in replace_triggered_by
（途中省略：属性の差分詳細）

  # local_file.ansible_inventory must be replaced
（途中省略：属性の差分詳細）

  # local_file.group_vars_target_nodes must be replaced
（途中省略：属性の差分詳細）

  # local_file.private_key must be replaced
（途中省略：属性の差分詳細）

  # tls_private_key.generated is tainted, so must be replaced
（途中省略：属性の差分詳細）

Plan: 7 to add, 0 to change, 7 to destroy.

（途中省略：Changes to Outputs）

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

（途中省略：local_fileの破棄完了ログ）

docker_container.targets["target-node3"]: Destroying... [id=57a98bce45f31093768e32c07b51d18648afb76bb9f05fe0e6385ba1a87f88d4]
docker_container.targets["target-node1"]: Destroying... [id=6657146a4967b84f11ed579ad63a7eafb50e5602f5f2bc21cc4e9cc3dc8ad259]
docker_container.targets["target-node2"]: Destroying... [id=553df1c0a05cc234d1090712ef15b32f59bad941bc77375dce41a18f178def14]
docker_container.targets["target-node2"]: Destruction complete after 1s
docker_container.targets["target-node3"]: Destruction complete after 1s
docker_container.targets["target-node1"]: Destruction complete after 1s
tls_private_key.generated: Destroying... [id=024a635616465ce17e5b5d2914cd39abefe64dc6]
tls_private_key.generated: Destruction complete after 0s
tls_private_key.generated: Creating...
tls_private_key.generated: Creation complete after 0s [id=b82d28946b4151ab66c0c624148fa1678e3da4bc]

（途中省略：local_file、docker_containerの作成完了ログ）

Apply complete! Resources: 7 added, 0 changed, 7 destroyed.
```

### ■ 結果

`prevent_destroy`を削除した状態で`terraform apply`を実行したところ、セクション3では確認プロンプトに到達する前に停止していた処理が、今回は`Do you want to perform these actions?`の確認プロンプトまで進み、`yes`の入力後、target-node1〜3、`tls_private_key.generated`、関連する`local_file`すべてが正常に再生成されました。`Apply complete! Resources: 7 added, 0 changed, 7 destroyed`という結果は、セクション3で止まっていた再生成が、`prevent_destroy`という単一の設定の有無だけで実行可否が切り替わることを示しています。

`prevent_destroy`を外すという対処自体は、破棄を防ぐ機能を一時的に無効化する行為であり、設定消失を防ぐという当初の目的そのものを放棄することになります。安全に再構築する方法は **[第47回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/)** に譲り、ここでは詰まりが解消される挙動そのものを確認するにとどめます。

---

[↑ 目次に戻る](#-目次)

---

## 6. まとめ

この回で整理した内容を確認します。

* `lifecycle`ブロックに`prevent_destroy = true`を設定すると、そのリソースを破棄する計画が`terraform plan`・`apply`の時点でエラーとして拒否されることを実機で確認した
* `docker_container.targets`は`for_each`によって一括生成されているため、`lifecycle`ブロックをインスタンスごとに個別指定できない。`prevent_destroy`もこの制約の対象であり、`replace_triggered_by`の条件を満たした際、target-node1〜3の3台すべてに`Error: Instance cannot be destroyed`が同時に発生することを実機で確認した
* `prevent_destroy`は、破棄を伴う変更を一律で拒否する設定であり、意図しない誤破壊と意図した再構築の要求を区別しない。ベースイメージの更新等でリソースの再作成が必要になった場合、Ansible側の再プロビジョニング要求そのものが発生する機会を持たないまま、`terraform apply`が停止することを整理した
* `terraform apply`がエラーメッセージで停止すると、CI/CDパイプラインを組んでいる場合はそこで処理全体が止まる。`prevent_destroy`を`main.tf`から削除し、`terraform apply`を再実行することで、詰まっていた再生成が実行され、処理が再開することを実機で確認した
* `prevent_destroy`を外すという対処は、破棄を防ぐ機能を一時的に無効化する行為であり、**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** の設定消失を防ぐという当初の目的そのものを放棄することになる。「破棄を防ぐ」ことと「安全に再構築する」ことは異なる課題であり、後者には別の設計が必要である

---

[↑ 目次に戻る](#-目次)

---

## 7. 次回予告

第43回となる今回は、**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** で確認した設定消失への対策として直感的に思いつく「破棄そのものを禁止する」というアプローチを、`prevent_destroy`という設定を通じて検証しました。`prevent_destroy`単体の仕組み、**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** の再生成条件との衝突、Ansible側の再プロビジョニング要求との衝突という3つの角度から整理したうえで、この設定が消失を防ぐ代わりに、デプロイそのものを詰まらせるという別の障害を引き起こすことを実機で確認しました。

次回は視点を変え、`prevent_destroy`を設定していない通常の再生成において、Ansibleが作成したデータそのものが完全に失われる「データ消失障害」を、ファイルだけでなくデータベースの状態等、より広い範囲で扱います。

**[次回：第44回：リソース再生成に伴うAnsible生成データの全喪失（データ消失障害）](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)　｜　[次の記事：【Ansible×Terraform編】第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第5部まとめブログ：Terraformライフサイクル破壊編で明らかになった「認識の不可視性」の構造** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 8. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

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