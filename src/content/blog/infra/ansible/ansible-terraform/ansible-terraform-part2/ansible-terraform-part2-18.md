---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第18回：TerraformとAnsible Vaultにおける機密情報の役割分担'
description: 'データベースのパスワードやAPIキーなどの機密情報を、TerraformとAnsible Vaultのどちらで暗号化し、どのように管理すべきかを整理する。Terraformの`sensitive`属性が持つ限界と、機密情報の性質による責務分担の考え方、Vaultの誤用パターンとその回避策を実機で確認する。'
pubDate: '2026-08-21'
category: 'infra'
tags: ['Ansible', 'Terraform', 'Ansible Vault', 'tfstate', '機密情報管理']
seriesId: 'ansible-terraform-part2'
seriesNo: 18
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-17/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-19/'
relatedSeries: ''
---

<style> table th, table td { word-break: normal; } table td:first-child { white-space: nowrap; } </style>

> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第2部まとめブログ： TerraformとAnsibleの運用で直面する構成ズレと状態管理の問題** **※近日公開予定**

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [Terraformが機密情報を扱う場面とリスク](#2-terraformが機密情報を扱う場面とリスク)
3. [Ansible Vaultが機密情報を扱う場面](#3-ansible-vaultが機密情報を扱う場面)
4. [機密情報の性質による責務分担の判断軸](#4-機密情報の性質による責務分担の判断軸)
5. [Vault誤用パターン](#5-vault誤用パターン)
6. [誤用の回避策](#6-誤用の回避策)
7. [まとめ](#7-まとめ)
8. [次回予告](#8-次回予告)
9. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#9-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

「暗号化しているから安全」と思っていたVaultファイルのパスワードが、チャットに平文で流れていた、という経験はないでしょうか。

**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-17/)** では、リソース再生成によってIPアドレスという識別子が変わった際、その変化がインベントリや関連設定にどう波及するかを整理しました。今回扱うのは、識別子ではなく**機密情報**という、別種のデータです。

データベースのパスワードやAPIキーといった機密情報は、TerraformとAnsibleのどちらの文脈でも登場します。TerraformはVariableに`sensitive`属性を指定でき、AnsibleはVaultという暗号化の仕組みを持っています。両方のツールが機密情報を扱う手段を持っているために、「どちらで管理すべきか」の判断がつきにくい状態が生まれます。

このテーマは、**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-15/)** とも接続します。第15回では、tfstateをGit管理するアンチパターンを扱う中で、tfstateに機密情報が平文で含まれる構造に軽く触れました。今回は、この扱いを正面から整理します。

具体的には、次のような場面です。

* Terraformの変数に`sensitive = true`を指定していれば、機密情報は安全に保護されていると考えていた
* Ansible Vaultでパスワードを暗号化しているものの、そのVaultファイルを復号するためのパスワード自体は、Vaultの管理範囲の外にある
* インフラの認証情報とアプリケーションの機密情報を、特に区別せず同じ場所で管理していた

この回で扱う問いは、「機密情報の種類・使われる場所によって、TerraformとAnsible Vaultのどちらに責務を寄せるべきか」です。あわせて、Vaultを使っていること自体が誤用の防止にはならない、いくつかの典型的な誤用パターンとその回避策も整理します。

次のセクションでは、まずTerraform側が機密情報を扱う場面を確認し、`sensitive`属性が実際には何を保護し、何を保護しないのかを実機で確認します。

---

[↑ 目次に戻る](#-目次)

---

## 2. Terraformが機密情報を扱う場面とリスク

Terraform側で機密情報を扱う場面とその構造的リスクを整理します。

Terraformが機密情報を扱う典型的な場面として、以下が挙げられます。

* Terraformプロバイダーの接続情報・APIキー等、インフラリソースの作成・操作に直接使われる認証情報
* Terraform変数として渡すパスワード等、`sensitive = true`を指定して扱う値

`sensitive = true`を指定した変数がどのように動作するかを、実機で確認します。

* **ファイル名：**`main.tf`（追記部分）
```hcl
variable "db_password" {
  type      = string
  sensitive = true
  default   = "P@ssw0rd_demo_2026"
}

output "db_password_output" {
  value     = var.db_password
  sensitive = true
}
```

### ■ 検証内容（`sensitive = true`を指定した変数が、コンソール出力とtfstateでそれぞれどう扱われるかの確認）

**実行コマンド**
```plaintext
terraform apply
```

**▼ 実行結果**
```plaintext
docker_network.lab_net: Refreshing state... [id=261d153c5dc82cf69950a9289c1726cbde2f5a14fa9b2f395c58434d13c4a354]
docker_image.ansible_target_legacy: Refreshing state... [id=sha256:6396f6e711cb1cce4aaec489d9944bcf5f3e19997cb94345e194da7ca1b62b5aansible-target:ubuntu18.04]
docker_image.ansible_target: Refreshing state... [id=sha256:3557c4c7ab005be7a378a329a5ca402ec4ae742c0b158cf872f2efe01bdb4a30ansible-target:ubuntu22.04]
docker_image.ansible_target_deploy_passwd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-passwd]
docker_image.ansible_target_deploy_nopasswd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-nopasswd]
tls_private_key.generated: Refreshing state... [id=01fef040852c30c6b7e1ca3cc397456584b4d7e4]
local_file.private_key: Refreshing state... [id=7d11d7745c28bb12f23b6501732973a67553e3e1]
null_resource.fix_permission: Refreshing state... [id=4436755063213838558]
docker_container.targets["target-node1"]: Refreshing state... [id=2dacb702c37e4ef0af967e2a09467936cd99653d2b9223042600fe3d522e867f]
docker_container.targets["target-node3"]: Refreshing state... [id=c0bf3acaad8594c22759d078da57ecea563acd09c383d5c0cd8e8eabb32ba1ea]
docker_container.targets["target-node2"]: Refreshing state... [id=2c42482c3ba9c43bd40621b90416b405323c8a6d4e09837d10ea455c58e6614d]
local_file.ansible_inventory: Refreshing state... [id=4d782ddc4bb331aa4c91429bfe03443a74abb2ca]
null_resource.provision: Refreshing state... [id=5876942731684570095]

Changes to Outputs:
  + db_password_output = (sensitive value)

You can apply this plan to save these new output values to the Terraform state, without changing any real infrastructure.

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

Apply complete! Resources: 0 added, 0 changed, 0 destroyed.

Outputs:

db_password_output = <sensitive>
target_nodes_ips = {
  "target-node1" = "172.20.0.2"
  "target-node2" = "172.20.0.6"
  "target-node3" = "172.20.0.4"
}
```

`plan`の差分表示では`(sensitive value)`、`apply`完了後の出力では`<sensitive>`と表示され、`db_password`に設定した実際の値はコンソール上のどこにも表示されません。

続けて、tfstateファイルの中身を直接確認します。

**実行コマンド**
```plaintext
cat terraform.tfstate | grep -A 3 db_password
```

**▼ 実行結果**
```plaintext
    "db_password_output": {
      "value": "P@ssw0rd_demo_2026",
      "type": "string",
      "sensitive": true
```

### ■ 結果

コンソール出力では隠れていた値が、tfstateファイルには`"value": "P@ssw0rd_demo_2026"`として平文のまま記録されていました。

ここで注目したいのは、`"sensitive": true`というフラグ自体はtfstateの中にも存在しているという点です。しかし、このフラグはあくまで「この値をコンソールに表示する際は隠す」という表示制御のためのメタデータであり、tfstateへの保存内容そのものには一切関与しません。値は暗号化されることも、マスクされることもなく、フラグの隣にそのまま平文で置かれています。

`sensitive = true`は、`terraform plan`や`apply`の実行ログを人が目で追う際に、誤って機密情報を画面やCIのログに流出させてしまうことを防ぐための機能です。一方で、tfstate自体が漏洩した場合、あるいはtfstateへのアクセス権限を持つ人であれば、`sensitive`の指定の有無にかかわらず、値はそのまま読み取れます。**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-15/)** でtfstateのGit管理をアンチパターンとして扱った際に触れた「機密情報が平文で含まれる」という構造は、この検証で確認した通りの実態です。

`sensitive`は表示の保護であって、保存の保護ではないという点を、ここで明確にしておきます。この限界を踏まえたうえで、次のセクションではAnsible Vault側が機密情報をどう扱うかを確認し、両者の性質の違いを対比します。

---

[↑ 目次に戻る](#-目次)

---

## 3. Ansible Vaultが機密情報を扱う場面

Ansible Vault側の機密情報管理の仕組みを整理します。

Playbook内で使うパスワード・APIキーをVaultで暗号化し、実行時にVaultパスワードで復号する仕組みを、実機で確認します。

まず、機密情報を記述したファイルを用意します。

* **ファイル名：**`secrets.yml`
```yaml
db_password: P@ssw0rd_demo_2026
```

このファイルを`ansible-vault encrypt`で暗号化します。

**実行コマンド**
```plaintext
ansible-vault encrypt secrets.yml
```

暗号化後、ファイルの中身を確認します。

* **ファイル名：**`secrets.yml`（暗号化後）
```plaintext
$ANSIBLE_VAULT;1.1;AES256
61313939373930656163396264333933343831346436326630623064313865313233623831316230
3838313530306137616139336565336665373665623538330a633137363562326332323162663136
36333562373938323838363064353532623763636637383232633837316534393434323435643662
3134633731306534630a653664333566353039386636353764633234633034346137303263356437
31376438313437613563373634666165336234303533316533386666666365333638656637323663
6663663734373334616461323834353065326361653532326135
```

暗号化前は`db_password: P@ssw0rd_demo_2026`という平文だったファイル全体が、`$ANSIBLE_VAULT;1.1;AES256`から始まる暗号化データに変わりました。セクション2で確認したTerraformの`sensitive`が、あくまでコンソール表示だけを隠す仕組みだったのに対し、Ansible Vaultはファイルの内容そのものを暗号化して保存する仕組みであることが、この時点ですでに分かります。

続いて、この`secrets.yml`を読み込むだけの検証用Playbookを用意します。

* **ファイル名：**`check_secrets.yml`
```yaml
---
- hosts: target-node1
  vars_files:
    - secrets.yml
  tasks:
    - name: 復号された機密情報を表示
      debug:
        var: db_password
```

### ■ 検証内容（暗号化されたVaultファイルが、正しいパスワードでのみ復号され利用できることの確認）

まず、正しいVaultパスワードを指定してPlaybookを実行します。

**実行コマンド**
```plaintext
ansible-playbook -i ~/iac/docker-lab/inventory.ini check_secrets.yml --ask-vault-pass
```

**▼ 実行結果**
```plaintext
Vault password:

PLAY [target-node1] *************************************************************************************************************************************************************************

TASK [Gathering Facts] **********************************************************************************************************************************************************************
ok: [target-node1]

TASK [復号された機密情報を表示] *************************************************************************************************************************************************************
ok: [target-node1] => {
    "db_password": "P@ssw0rd_demo_2026"
}

PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

`Vault password:`のプロンプトに、暗号化時に設定したパスワードを入力すると、Playbook実行時に自動的に復号が行われ、`debug`タスクの出力に`db_password`の値がそのまま表示されました。

続けて、あえて誤ったパスワードを指定して同じPlaybookを実行します。

**実行コマンド**
```plaintext
ansible-playbook -i ~/iac/docker-lab/inventory.ini check_secrets.yml --ask-vault-pass
```

**▼ 実行結果**
```plaintext
Vault password:
ERROR! Decryption failed (no vault secrets were found that could decrypt) on /home/control/iac/ansible/secrets.yml
```

誤ったパスワードでは`ERROR! Decryption failed`となり、復号自体が失敗し、Playbookは実行されませんでした。

### ■ 結果

正しいVaultパスワードを持つ場合のみ`secrets.yml`の内容が復号され、Playbookから参照できることが確認できました。誤ったパスワードでは復号そのものが失敗し、ファイルの中身には一切アクセスできません。

セクション2で確認した`sensitive`との違いは明確です。`sensitive`は、値をコンソール出力から隠すだけで、ファイル（tfstate）自体には平文のまま値が保存されていました。一方Ansible Vaultは、ファイルの内容そのものをAES256で暗号化して保存するため、ファイルを直接開いても、正しいパスワードなしには元の値を読み取ることができません。「表示を隠す」仕組みと「保存を暗号化する」仕組みという、両者の性質の違いがここで対比できます。

ただし、この仕組みが機能するのはあくまで「正しいVaultパスワードを知っている人だけが復号できる」という前提があってこそです。次のセクションでは、この前提を踏まえたうえで、機密情報の性質によってTerraform側とAnsible Vault側のどちらに責務を寄せるべきかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 4. 機密情報の性質による責務分担の判断軸

セクション2、3を踏まえ、どちらに何を持たせるかの判断基準を整理します。

セクション2で確認した通り、Terraformの`sensitive`はコンソール表示を隠すものの、tfstateには平文で残ります。セクション3で確認した通り、Ansible Vaultはファイル自体を暗号化して保存します。この性質の違いを踏まえると、両ツールのどちらに機密情報の管理を寄せるべきかは、機密情報がどこで、何のために使われるかによって決まります。

機密情報の性質による責務分担を、以下のように整理します。

|機密情報の種類|管理する側|理由|
|---|---|---|
|Terraformプロバイダーの接続情報・APIキー|Terraform側|インフラリソースの作成・操作に直接使われるため|
|OS・ミドルウェアの管理者パスワード|Ansible Vault側|リソース内部の設定投入時に使われるため|
|アプリケーションのDBパスワード・APIキー|Ansible Vault側|Playbookで設定ファイルに書き込む対象のため|

この表が示す分担の考え方は、単純化すると次のようになります。

```plaintext
インフラを作るための鍵：Terraform側
インフラの中身に設定する鍵：Ansible Vault側
```

Terraformプロバイダーの接続情報は、`terraform apply`を実行する際にTerraform自身が使う認証情報です。この情報がなければ、そもそもリソースの作成や変更ができません。Terraformの実行そのものに不可欠な情報であるため、Terraform側の変数として扱うのが自然です。

一方、OS内部の管理者パスワードや、アプリケーションのDBパスワード・APIキーは、いずれもリソースが作られた後に、リソースの内部に投入される機密情報です。これらは`docker_container`や仮想マシンといったリソースそのものの作成には関与せず、Ansibleが設定ファイルへの書き込みやアプリケーションの起動処理として扱う対象です。この種の機密情報は、Ansible Vaultで暗号化し、Playbook実行時に復号して使う構成が適しています。

この分担は、セクション2、3で確認した両ツールの性質の違いとも整合します。Terraformが管理するtfstateは、リソースの現在の状態を丸ごと記録するファイルであり、`sensitive`を指定しても値は平文のまま残ります。インフラの接続情報程度であればこの構造でも許容範囲に収まりますが、OSやアプリケーション内部の機密情報まで同じ場所に集約すると、tfstateという単一のファイルに機密情報が集中し、漏洩時の影響範囲が広がります。Ansible Vaultで暗号化して管理する側に寄せることで、この集中を避けられます。

なお、この判断軸はあくまで大枠の考え方であり、すべての現場に機械的に当てはまるものではありません。例えば、Terraformが管理するクラウドリソース自体にDBが含まれ、そのDBの初期パスワードをTerraform側で払い出す必要がある構成もあります。重要なのは、「その機密情報が主にどちらのツールの実行に必要とされているか」を基準に判断することであり、次のセクションでは、この判断軸を無視した場合に起きがちな誤用パターンを見ていきます。

---

[↑ 目次に戻る](#-目次)

---

## 5. Vault誤用パターン

Vaultの使い方で陥りやすい誤用パターンを整理します。

セクション3で確認した通り、Ansible Vaultは正しいパスワードなしには復号できない、堅牢な暗号化の仕組みを持っています。しかし、この仕組みが機能するかどうかは、運用の仕方次第です。Vaultを使っていること自体が、誤用からの安全を保証するわけではありません。

以下、典型的な誤用パターンを示します。

### パスワード管理ツール代わりに使う誤用

Vaultファイルに、その時々で必要になった機密情報を無秩序に追加し続けるケースです。何が暗号化されているか、誰がいつ追加したかが追跡できなくなり、Vaultファイルの中身の把握そのものが特定の担当者だけに依存する状態、いわゆる管理の属人化が起きます。Vaultはあくまで暗号化の手段であり、機密情報のライフサイクル（誰が発行し、誰が使い、いつ失効させるか）を管理する仕組みではありません。この役割をVaultファイルに肩代わりさせようとすると、ファイルが肥大化し、内容の棚卸しが難しくなります。

### Vaultパスワード自体の平文共有

Vaultファイルを復号するためのパスワードを、リポジトリのREADMEやチャットツールに平文で共有してしまうケースです。セクション3で確認した通り、Ansible Vaultの暗号化強度自体は堅牢ですが、その復号キーであるVaultパスワードが誰でも読める場所に置かれていれば、暗号化していることの意味そのものが失われます。「暗号化してあるから安全」という認識が、Vaultパスワードの取り扱いへの意識を薄れさせ、この誤用を招きやすくします。

### 暗号化粒度が粗いことによる非効率

ファイル全体を暗号化する運用にしていると、1つの値だけを更新したい場合でも、ファイル全体を復号し、編集し、再度暗号化するという手順が毎回必要になります。セクション3で暗号化した`secrets.yml`も、ファイル単位での暗号化でした。機密情報の数が増えるほど、この手順の負担は大きくなり、差分としてどの値が変わったのかも、暗号化された状態のままでは追いにくくなります。結果として、更新作業そのものが敬遠され、機密情報が古いまま放置されるという別の問題につながることもあります。

これらのパターンに共通するのは、いずれも「暗号化していれば安全」という前提を、運用の実態が裏切っている点です。ファイルの中身が暗号化されていても、管理が属人化していれば誰が何を把握しているか分からず、パスワードが漏れていれば暗号化は無意味であり、粒度が粗ければ更新自体が滞ります。暗号化という技術的な対策と、それを支える運用上の設計は、別々に整える必要があります。

次のセクションでは、これらの誤用パターンに対する具体的な回避策を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 6. 誤用の回避策

セクション5の誤用パターンに対する具体的な回避策を整理します。

### Vaultパスワード自体の分離管理

Vaultパスワードをリポジトリやチャットで共有せず、環境変数や外部のSecret Manager（具体的な導入手順はここでは扱いません）で個別に管理する方針を示します。

セクション5で確認した通り、Vaultパスワードが誰でも読める場所に置かれていれば、Ansible Vaultの暗号化強度そのものは意味を持ちません。Vaultパスワードは、Vaultファイルとは完全に別の経路で管理し、必要な人だけがアクセスできる状態を保つ必要があります。`--vault-password-file`オプションでパスワードファイルを参照する運用にする場合も、そのファイル自体をリポジトリに含めない、パーミッションを適切に絞るといった扱いが前提になります。

### 変数単位の暗号化

`ansible-vault encrypt_string`を使うことで、ファイル全体ではなく特定の変数だけを暗号化できます。実機で確認します。

**実行コマンド**
```plaintext
ansible-vault encrypt_string 'P@ssw0rd_demo_2026' --name 'db_password'
```

**▼ 実行結果**
```plaintext
New Vault password:
Confirm New Vault password:
Encryption successful
db_password: !vault |
          $ANSIBLE_VAULT;1.1;AES256
          38656137626666643162313834653931383766653436316634373231633334323836346636326264
          3064346532343762323538353135613930306531646663650a363361626164313462346630376635
          38386235326630343433386664306131383739333639653166653163353764383266363264643630
          6434326635366530660a363630313432373937346438613233376633303862653434633238313535
          31313837326665343733323935303033313165623863386337353664303765363163
```

セクション3の`secrets.yml`はファイル全体を暗号化した結果、ファイルを開いても内容が一切見えない状態でした。一方`encrypt_string`は、`db_password`という単一の値だけを暗号化します。この出力をそのままYAMLファイルに組み込みます。

* **ファイル名：**`secrets_string.yml`
```yaml
db_password: !vault |
          $ANSIBLE_VAULT;1.1;AES256
          38656137626666643162313834653931383766653436316634373231633334323836346636326264
          3064346532343762323538353135613930306531646663650a363361626164313462346630376635
          38386235326630343433386664306131383739333639653166653163353764383266363264643630
          6434326635366530660a363630313432373937346438613233376633303862653434633238313535
          31313837326665343733323935303033313165623863386337353664303765363163
```

このファイルは、`cat`で開いても構造自体は読めます。暗号化されているのは`db_password`の値だけで、変数名（キー）は平文のままです。実際にPlaybookから読み込み、正しく復号されることを確認します。

**実行コマンド**
```plaintext
ansible-playbook -i ~/iac/docker-lab/inventory.ini check_secrets_string.yml --ask-vault-pass
```

**▼ 実行結果**
```plaintext
Vault password:

PLAY [target-node1] *************************************************************************************************************************************************************************

TASK [Gathering Facts] **********************************************************************************************************************************************************************
ok: [target-node1]

TASK [復号された機密情報を表示] *************************************************************************************************************************************************************
ok: [target-node1] => {
    "db_password": "P@ssw0rd_demo_2026"
}

PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

正しいパスワードで、`db_password`の値だけが復号され、正常に表示されました。

この方式であれば、複数の機密情報を1つのYAMLファイルにまとめつつ、それぞれの値だけを個別に暗号化できます。1つの値を更新したい場合も、そのキーに対して`encrypt_string`を再実行し、該当行だけを差し替えれば済みます。ファイル全体を復号、編集、再暗号化する必要がなく、セクション5で触れた「暗号化粒度が粗いことによる非効率」を避けられます。また、変数名がYAML上で平文のまま読めるため、ファイルの中にどんな種類の機密情報が存在するかを、復号せずに一覧できるという利点もあります。

### 管理フローの明確化

Vaultファイルの責任者・更新時の承認フローを運用ルールとして明確にすることで、属人化を防ぐ方針を示します。

セクション5で触れた「パスワード管理ツール代わりに使う誤用」は、技術的な対策だけでは防げません。誰がVaultファイルへの追加、更新を行えるか、更新時にレビューを挟むかといった運用ルールを明文化し、担当者が変わっても運用が継続できる状態にしておくことが必要です。`encrypt_string`による変数単位の暗号化は、この管理フローを支える技術的な土台にはなりますが、フロー自体を代替するものではありません。

---

[↑ 目次に戻る](#-目次)

---

## 7. まとめ

この回で整理した内容を確認します。

* Terraformの`sensitive = true`は、`terraform plan`・`apply`のコンソール出力で値を隠すが、tfstate自体には平文で保存される。実機検証では、コンソール上は`<sensitive>`と表示される一方、tfstateファイルには`"value": "P@ssw0rd_demo_2026"`として平文で記録されている様子を確認した
* Ansible Vaultは、`ansible-vault encrypt`によってファイルの内容そのものを暗号化して保存する。実機検証では、暗号化後のファイルが`$ANSIBLE_VAULT;1.1;AES256`形式のデータに変わり、正しいVaultパスワードでのみ復号できる一方、誤ったパスワードでは`ERROR! Decryption failed`となり復号自体が失敗する様子を確認した
* 機密情報の性質によって、インフラリソースの作成・操作に直接使われる認証情報はTerraform側、OS・アプリケーション内部で使われる機密情報はAnsible Vault側という責務分担の考え方がある
* Vaultをパスワード管理ツール代わりに使う、Vaultパスワード自体を平文共有する、暗号化粒度が粗いことによる非効率、といった誤用パターンは、いずれも「暗号化していれば安全」という前提を運用の実態が裏切ることで生じる
* `ansible-vault encrypt_string`による変数単位の暗号化は、ファイル全体ではなく特定の値だけを暗号化できる。実機検証では、変数名は平文のまま、値だけが暗号化された状態でPlaybookから正しく復号できることを確認した。Vaultパスワードの分離管理、管理フローの明確化とあわせて、誤用を防ぐ具体策になる

---

[↑ 目次に戻る](#-目次)

---

## 8. 次回予告

**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-17/)** では、リソース再生成によってIPアドレスという識別子が変わった際、その変化がインベントリや関連設定にどう波及するかを整理しました。

今回はその視点を、識別子の変化から機密情報の管理という、両ツールの責務分担そのものへ移しました。Terraformの`sensitive`属性がコンソール表示を隠す一方でtfstateには平文で残る様子と、Ansible Vaultがファイル自体を暗号化して保存し、正しいパスワードでのみ復号できる様子を実機で確認しました。あわせて、機密情報の性質による責務分担の判断軸、Vaultの典型的な誤用パターン、`encrypt_string`による変数単位の暗号化を含む回避策を整理しました。

次回は、OSのメジャーバージョンアップに伴うPlaybookの互換性検証を扱います。Terraform側でベースイメージ（例：Ubuntu 22.04→24.04）を変更した際、Ansibleの古い独自モジュールやシェルコマンドが機能しなくなるケースを取り上げます。今回が機密情報という運用上のデータ管理を扱ったのに対し、次回は **[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-16/)**（パッケージアップデート）よりさらに大きな変化であるOSメジャーバージョンアップへの対応に入ります。

**[次回：第19回：OSのメジャーバージョンアップ時におけるPlaybookの互換性検証](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-19/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-17/)　｜　[次の記事：【Ansible×Terraform編】第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-19/)**

---

> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第2部まとめブログ： TerraformとAnsibleの運用で直面する構成ズレと状態管理の問題** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 9. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

### 第2部：運用・ライフサイクル編

|回数|テーマ・記事タイトル|概要|
|---|---|---|
|**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)**|手動変更による構成ドリフトの検知と同期手法|構築後に手動やAnsibleで変更したOS内部の状態を、Terraformの`plan`が検知できず、インフラの管理状態に不整合が出る問題。ドリフトシリーズとの接続を示す。|
|**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-12/)**|`terraform apply`実行時における初期化処理とOS設定の上書き問題|Terraform側で初期化スクリプトやコンテナ起動定義を書き換えて再実行した際、Ansibleによって設定済みのOS内部状態が初期化される課題。|
|**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)**|コード修正に伴うリソースの強制再生成（リビルド）リスク|TerraformのHCL定義変更によって、リソースが「更新」ではなく「破棄、再生成」され、Ansibleが投入した内部データが消失する課題。|
|**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/)**|複数回実行時におけるAnsible Playbookの冪等性の確保|`terraform apply`のlocal-exec経由でAnsibleが複数回実行される構成において、冪等性が確保されていないPlaybookがterraform apply自体の失敗を引き起こす問題。|
|**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-15/)**|チーム運用における状態管理ファイル（tfstate）の整合性維持|Ansibleを実行するオペレーターと、Terraformを管理するエンジニア間で、Terraformの状態管理ファイルに競合が発生するリスク。チーム運用での役割分担設計も整理する。|
|**[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-16/)**|パッケージアップデートに伴う環境の非互換性への対応|運用中に`apt update`等を実行した結果、OSのライブラリやミドルウェアのバージョンが上がり、Terraformの定義と矛盾が生じるケース。|
|**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-17/)**|リソース再生成時におけるIPアドレス変動と接続情報の更新遅延|リソース（コンテナ/VM）の再生成に伴ってIPアドレスが変更された際、Ansible用のインベントリや各種設定ファイルの書き換えが追いつかない問題。|
|**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)**|TerraformとAnsible Vaultにおける機密情報の役割分担|データベースのパスワードやAPIキーなどの機密情報を、両ツールのどちらで暗号化し、どのように管理すべきかの運用設計。Vault誤用パターンと回避策も整理する。|
|**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-19/)**|OSのメジャーバージョンアップ時におけるPlaybookの互換性検証|Terraform側でベースイメージ（例：Ubuntu 22.04→24.04）を変更した際、Ansibleの古い独自モジュールやシェルコマンドが機能しなくなる課題。|
|**[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-20/)**|運用編まとめ：ミュータブル運用とイミュータブル運用の折衷案|状態（データ）を維持し続ける運用（ミュータブル）と、使い捨てる運用（イミュータブル）を、両ツールの組み合わせでどのように着地させるかの最適解。|

---

[↑ 目次に戻る](#-目次)

---
