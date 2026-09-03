---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第34回：Testinfraによる状態検証を組み込んだCI/CDパイプライン'
description: 'Ansible適用後の状態をTestinfra（Python）で検証し、TerraformとAnsibleそれぞれの成功報告に依存しないパイプライン全体の最終確認を組み込む設計を扱う。docker・sshバックエンドによる、ローカル環境とCI環境の使い分けも整理する。'
pubDate: 2026-09-04
category: 'infra'
tags: ['Ansible', 'Terraform', 'Testinfra', 'pytest', 'CI/CD']
seriesId: 'ansible-terraform-part4'
seriesNo: 34
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-33/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-35/'
relatedSeries: ''
---


<style> table th, table td { word-break: normal; } table td:first-child { white-space: nowrap; } </style>

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」シリーズ統合ブログ** **※近日公開予定**

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [TerraformとAnsibleの成功報告がそれぞれ独立している構造](#2-terraformとansibleの成功報告がそれぞれ独立している構造)
3. [パイプラインとして見た場合の空白地帯](#3-パイプラインとして見た場合の空白地帯)
4. [Testinfraの複数の接続方式](#4-testinfraの複数の接続方式)
5. [Ansible適用結果に対応する検証項目の設計](#5-ansible適用結果に対応する検証項目の設計)
6. [実行環境に応じた接続方式の使い分け](#6-実行環境に応じた接続方式の使い分け)
7. [パイプライン全体における位置づけ](#7-パイプライン全体における位置づけ)
8. [まとめ](#8-まとめ)
9. [次回予告](#9-次回予告)
10. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#10-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

`terraform apply`が成功し、`ansible-playbook`も`failed=0`で完了した。そのとき、パイプライン全体が意図通りに完了したと言い切れるでしょうか。

**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** では、`local-exec`経由でAnsibleを直接実行する密結合構成を見直し、Terraformの責務を状態（tfstate、`output`）の出力に限定する疎結合設計への移行を扱いました。**[第32回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/)** では、この疎結合化によって生じた実行順序の課題に対し、GitHub Actions上でコンテナ起動からAnsible適用までを一連のジョブとして自動実行する仕組みを扱いました。**[第33回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-33/)** では、視点をさらに変え、Playbookの内容に変更がない場合はAnsible実行そのものをスキップする、実行するかどうかという判断自体をTerraformの状態管理に組み込む設計を扱いました。

第34回となる今回は、再び視点を変えます。接続させた結果、パイプライン全体が本当に意図通りに完了したことを、誰がどう確認するかを扱う回です。

`terraform apply`の成功は、tfstateと定義ファイルが整合していることを示しているに過ぎません。`ansible-playbook`の成功も、各タスクが`failed`にならなかったことを示しているに過ぎません。両者はそれぞれ自分の管理範囲の中でしか成功を報告しておらず、互いの管理範囲を検証し合ってはいません。

問いは、「それぞれ独立して動くTerraformとAnsibleの成功報告を足し合わせても、パイプライン全体の成功を意味しないのはなぜか、そしてその確認を誰が担うべきか」です。

次のセクションでは、この問いの前提となる、両ツールの成功報告がそれぞれ独立している構造を確認します。

---

[↑ 目次に戻る](#-目次)

---


## 2. TerraformとAnsibleの成功報告がそれぞれ独立している構造

この回の前提を整理します。

`terraform apply`の成功と`ansible-playbook`の成功が、それぞれ何を保証しているのかを確認します。
```

terraform apply の成功が意味すること  
　└─ tfstateとTerraformの定義（.tfファイル）が整合していること  
　　　（コンテナ内部の実際の状態は見ていない）

ansible-playbook の成功が意味すること  
　└─ 各タスクが failed にならず ok または changed で終わったこと  
　　　（タスクの結果、最終的にどうなったかまでは保証しない）

````

両者は互いの管理範囲を検証し合っておらず、それぞれ「自分の仕事の範囲で問題がなかった」ことしか報告していません。

### ■ 検証内容：Terraform、Ansibleそれぞれの成功報告の確認

まず、`terraform plan`で現在のインフラの状態を確認します。

**実行コマンド**

```plaintext
terraform plan
```

**▼ 実行結果**

```plaintext
docker_network.app_net: Refreshing state... [id=54f7b73fd1625642a3ef6ed67fbde6f93062353422a9afeced223cd940c4c5ca]
docker_image.ansible_target_deploy_passwd: Refreshing state... [id=sha256:82e7f3fe0d4812ff81d66c343eb1c9256083f74beaa95a6ea0cbbd4cf248649dansible-target:deploy-passwd]
docker_image.ansible_target_deploy_nopasswd: Refreshing state... [id=sha256:82e7f3fe0d4812ff81d66c343eb1c9256083f74beaa95a6ea0cbbd4cf248649dansible-target:deploy-nopasswd]
docker_image.ansible_target_legacy: Refreshing state... [id=sha256:a16c62a2699b6a0020002e924eff95e64e701b5f89b92247875e66365ced49b0ansible-target:ubuntu18.04]
docker_network.lab_net: Refreshing state... [id=261d153c5dc82cf69950a9289c1726cbde2f5a14fa9b2f395c58434d13c4a354]
docker_image.ansible_target: Refreshing state... [id=sha256:32ab5c4e8d486ce8c1c2437c66cd22ad3d90048329efe06897302d2ac49c6456ansible-target:ubuntu22.04]
tls_private_key.generated: Refreshing state... [id=01fef040852c30c6b7e1ca3cc397456584b4d7e4]
local_file.private_key: Refreshing state... [id=7d11d7745c28bb12f23b6501732973a67553e3e1]
null_resource.fix_permission: Refreshing state... [id=4436755063213838558]
docker_container.targets["target-node2"]: Refreshing state... [id=37e962b0b3bb12974d2ee0b51f9a16355f2c7b10b55db35dd54345e603a321e2]
docker_container.targets["target-node1"]: Refreshing state... [id=7e03f9cd1d76a21dc520e94eeb3f5342ff9f1e65f522e96bfe046f075ffcf243]
docker_container.targets["target-node3"]: Refreshing state... [id=d0edd0718c3e6fb1f5d98139a8ec8ad25fbffd5a6f535a4a7e16c052e0c9b879]
local_file.ansible_inventory: Refreshing state... [id=098eb605ab8be2e794bd80cb9a745ae80f1de98f]
local_file.group_vars_target_nodes: Refreshing state... [id=f8f757de49eab333f2dcdec781bcca8fdaedcef4]
null_resource.provision: Refreshing state... [id=1600380798870489971]
No changes. Your infrastructure matches the configuration.
Terraform has compared your real infrastructure against your configuration and found no differences, so no changes are needed.
```

続けて、`ansible-playbook`を単体で実行します。

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini site.yml
```

**▼ 実行結果**

```plaintext
PLAY [接続確認用Playbook] *******************************************************************************************************************************************************************
TASK [common : 疎通確認（common role・更新後）] *********************************************************************************************************************************************
[WARNING]: Platform linux on host target-node2 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node2]
[WARNING]: Platform linux on host target-node1 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node1]
[WARNING]: Platform linux on host target-node3 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node3]
PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

### ■ 結果

`terraform plan`は`No changes. Your infrastructure matches the configuration.`という結果を返しました。これは、tfstateとTerraformの定義ファイルの間に差分がないことを示しているに過ぎず、target-node1〜3のコンテナ内部で実際に何が起きているかについては、一切言及していません。

`ansible-playbook`は、target-node1〜3のすべてで`ok=1、changed=0、unreachable=0、failed=0`という結果を返しました。これは、`common`ロールの疎通確認タスクが3ホストすべてで`failed`にならなかったことを示しているに過ぎず、疎通確認というタスクの性質上、この結果自体がホストの詳細な内部状態（パッケージの有無やサービスの起動状態等）まで検証しているわけではありません。

この2つの結果を並べても、target-node1〜3が意図した状態になっているかどうかを、直接判断する材料にはなりません。`terraform plan`はTerraformの管理範囲（tfstateとの整合性）を、`ansible-playbook`はAnsibleの管理範囲（タスクの成否）を、それぞれ独立に報告しているに過ぎず、両者を足し合わせても、パイプライン全体としての最終的な状態確認にはならないことが確認できました。

---

[↑ 目次に戻る](#-目次)

---


## 3. パイプラインとして見た場合の空白地帯

問題の所在を明確にします。

`terraform apply`（または`terraform plan`）→`ansible-playbook`という一連の流れを1本のパイプラインとして見た場合に、最後にどのような確認が存在しないかを整理します。
```

terraform plan（No changes）  
　↓  
ansible-playbook（ok=1、failed=0）  
　↓  
❓ パイプライン全体としての最終確認が存在しない

```

セクション2で確認した`common`ロールの疎通確認タスク（`ansible.builtin.ping`）を例に、具体例を挙げます。

- `ok=1`という結果は、Ansibleがtarget-node1〜3に対してSSH接続を確立し、Pythonインタープリタ経由でモジュールを実行できたことを示しているに過ぎません。この結果は、疎通確認という限定的なタスクの範囲内での成功であり、コンテナ内部のその他の状態（意図した通りのパッケージやサービスが存在するか等）については何も検証していません
- `ok=1`は、あくまでタスクを実行したその瞬間の接続確立を示す結果です。この結果が出た直後にコンテナ側で何らかの理由（リソース逼迫やネットワーク設定の変化等）により接続性が失われたとしても、すでに完了した`ansible-playbook`の実行結果自体は`ok=1`のまま変わりません

いずれの場合も、`terraform plan`・`ansible-playbook`双方の終了コードは成功のままであり、この2つの出力だけでは検知できないことを整理します。

疎通確認というタスクの性質上、`ok=1`が保証しているのは「その瞬間、接続が確立できたこと」のみです。パイプラインが最終的に目指す「意図した状態になっているか」という確認とは、保証している範囲が異なります。

---

[↑ 目次に戻る](#-目次)

---


## 4. Testinfraの複数の接続方式

この回で導入する仕組みを示します。

Testinfraはpytestのプラグインとして動作し、`host`フィクスチャを通じてリモートホストの状態を検証できます。

* **ファイル名：`test_target_node1.py`**

```python
def test_openssh_server_installed(host):
    pkg = host.package("openssh-server")
    assert pkg.is_installed

def test_sshd_running(host):
    svc = host.service("ssh")
    assert svc.is_running
```

このテストコード自体は接続方式に依存せず、実行時のオプション指定によって`docker`バックエンド・`ssh`バックエンドを切り替えられます。

```plaintext
# dockerバックエンド（コンテナに直接接続）

$ pytest --connection=docker --hosts=target-node1,target-node2,target-node3 test_target_node1.py
```

このテストが、TerraformのtfstateにもAnsibleの実行ログにも一切依存せず、独立した経路でtarget-node1〜3の実際の状態を確認している点がポイントです。

### ■ 検証内容：dockerバックエンドによるTestinfra実行

**実行コマンド**

```plaintext
pytest --connection=docker --hosts=target-node1,target-node2,target-node3 test_target_node1.py
```

**▼ 実行結果**

```plaintext
==================================================================================== test session starts ====================================================================================
platform linux -- Python 3.10.12, pytest-9.1.1, pluggy-1.6.0
rootdir: /home/control/iac/docker-lab
plugins: testinfra-10.2.2
collected 6 items
test_target_node1.py ......                                                                                                                                                           [100%]
===================================================================================== 6 passed in 7.14s =====================================================================================
```

### ■ 結果

`test_openssh_server_installed`、`test_sshd_running`の2つのテストが、target-node1〜3それぞれに対して実行され、`collected 6 items`、`6 passed`という結果になりました。この実行は、`terraform apply`や`ansible-playbook`のログを一切参照せず、Docker API経由でコンテナに直接接続し、`openssh-server`パッケージのインストール状態と`ssh`サービスの起動状態を確認したものです。

セクション2で確認した`ansible-playbook`の疎通確認（`ok=1`）は、SSH接続が確立できたことのみを示していましたが、今回のTestinfraのテストは、その接続を支えているパッケージとサービスそのものの状態を、Ansibleの実行結果とは独立した経路で確認しています。

---

[↑ 目次に戻る](#-目次)

---

## 5. Ansible適用結果に対応する検証項目の設計

具体的な設計方針を示します。

検証環境の`common`ロールは、`ansible.builtin.ping`による疎通確認のみのタスク構成です。Ansibleがパッケージや設定ファイルを新規に投入しているわけではなく、この疎通確認タスク自体が、target-node1〜3に`openssh-server`がインストールされ、`ssh`サービスが起動していることを前提として成立しています。

このセクションでは、Ansibleが投入した内容そのものではなく、Ansibleの実行が依拠している前提条件を、Testinfraのテストケースと対応させる考え方を表で示します。

|Ansibleの疎通確認タスクが依拠している前提条件|Testinfraでの検証内容|
|---|---|
|SSHサーバーソフトウェアがインストールされていること|`host.package("openssh-server").is_installed`|
|SSHサービスが起動していること|`host.service("ssh").is_running`|

セクション2で確認した`ansible-playbook`の`ok=1`という結果は、この前提条件が満たされていたからこそ成立した結果です。しかし`ok=1`という結果自体は、SSH接続が確立できたことを示しているのみで、パッケージのインストール状態やサービスの起動状態そのものを直接検証しているわけではありません。

セクション4のTestinfraのテストは、Ansibleの実行ログを介さず、Docker API経由でコンテナに直接接続し、この前提条件そのものを独立した経路で確認しています。ここでの検証は、Ansibleの実行結果を追認するものではなく、Ansibleの実行が成立するための土台を、Ansibleの実行結果とは別の経路で確かめるものである点を改めて整理しておきます。

---

[↑ 目次に戻る](#-目次)

---

## 6. 実行環境に応じた接続方式の使い分け

2つの接続方式をどう使い分けるかを整理します。

ローカルのUbuntu-Control上での検証と、CI（GitHub Actions）上での検証で、それぞれ適した接続方式が異なります。
```

【ローカル環境（Ubuntu-Control上）】  
Testinfra --connection=docker  
　└─ Docker APIに直接アクセスできるため、SSH接続確立のオーバーヘッドがなく高速

【CI環境（GitHub Actionsのジョブ内）】  
Testinfra --connection=ssh（ホスト127.0.0.1、ポート2231〜2223）  
　└─ 第32回で構築したワークフローの中で、コンテナのSSHポートに対して接続する構成

````

同じテストコード（`test_target_node1.py`）を使い回せる点が、この使い分けの利点です。実行環境によってオプションを切り替えるだけで、テストの内容自体を変更する必要がありません。

### ■ 検証内容：sshバックエンドによるローカル環境での動作確認

セクション4で`docker`バックエンドを確認したのと同じテストコードを、`ssh`バックエンド指定で実行します。

**実行コマンド**

```plaintext
pytest --connection=ssh --hosts='ssh://ansible@127.0.0.1:2231,ssh://ansible@127.0.0.1:2222,ssh://ansible@127.0.0.1:2223' --ssh-identity-file=/home/control/.ssh/id_ed25519 --ssh-config=/home/control/iac/docker-lab/testinfra_ssh_config test_target_node1.py
```

**▼ 実行結果**

```plaintext
==================================================================================== test session starts ====================================================================================
platform linux -- Python 3.10.12, pytest-9.1.1, pluggy-1.6.0
rootdir: /home/control/iac/docker-lab-ci
plugins: testinfra-10.2.2
collected 6 items
test_target_node1.py ......                                                                                                                                                           [100%]
==================================================================================== 6 passed in 14.53s =====================================================================================
```

### ■ 検証内容：sshバックエンドによるCI環境での動作確認

同じテストコードを、GitHub Actions上のワークフローに組み込んで実行します。

* **ファイル名：`.github/workflows/e2e-provisioning-test.yml`（該当箇所）**

```yaml
      - name: Install Testinfra
        run: pip install pytest-testinfra
      - name: Create Testinfra SSH config
        run: |
          cat > ./testinfra_ssh_config << 'EOF'
          Host *
              StrictHostKeyChecking no
              UserKnownHostsFile /dev/null
          EOF
      - name: Run Testinfra
        run: |
          pytest --connection=ssh \
            --hosts='ssh://ansible@127.0.0.1:2231,ssh://ansible@127.0.0.1:2222,ssh://ansible@127.0.0.1:2223' \
            --ssh-identity-file=./id_ed25519_generated \
            --ssh-config=./testinfra_ssh_config \
            test_target_node1.py
```

**▼ 実行結果**

```plaintext
============================= test session starts ==============================
platform linux -- Python 3.12.14, pytest-9.1.1, pluggy-1.6.0
rootdir: /home/runner/work/ansible-terraform-ci-lab/ansible-terraform-ci-lab
plugins: testinfra-10.2.2
collected 6 items
test_target_node1.py ......                                              [100%]
============================== 6 passed in 7.97s ===============================
```

### ■ 結果

ローカル環境、CI環境のいずれも`6 passed`となり、同一のテストコード（`test_target_node1.py`）が、接続方式の指定を切り替えるだけで両方の環境で機能することが確認できました。ローカル環境は`--connection=docker`でDocker APIに直接アクセスする形、CI環境は`--connection=ssh`でコンテナの外部SSHポート（2231〜2223）に接続する形と、接続の経路自体はまったく異なりますが、テストの内容（`openssh-server`のインストール確認、`ssh`サービスの起動確認）は共通のまま検証できています。

`ssh`バックエンドでは、SSHのホストキー検証を回避するための設定ファイル（`testinfra_ssh_config`）を別途用意する構成になりました。ローカル環境では`known_hosts`に残った過去のホストキーとの不一致が、CI環境では初回接続時のホストキー確認が、それぞれこの設定ファイルによって回避されています。

---

[↑ 目次に戻る](#-目次)

---


## 7. パイプライン全体における位置づけ

これまでの内容をパイプラインの流れとして整理します。
```

① terraform apply （Terraformの管理範囲内での成功）  
　↓  
② ansible-playbook （Ansibleの管理範囲内での成功）  
　↓  
③ pytest（testinfra） （①②どちらにも依存しない独立した最終確認）

```

セクション2で確認した通り、①と②はそれぞれ自分の管理範囲の中でのみ成功を報告しています。セクション4〜6で確認したTestinfraは、①のtfstateにも②の実行ログにも依存せず、Docker API経由（ローカル環境）またはSSH経由（CI環境）で、target-node1〜3の実際の状態を独立に確認しました。

③が失敗した場合、①②がどちらも成功していたとしても、パイプライン全体としては失敗として扱います。①②の成功報告だけでは検知できなかった空白地帯（セクション3）を、③が埋める形になります。

あわせて、この位置づけには限界もあります。Testinfraはあくまで「あると運用の安心材料になる追加ステップ」であり、Testinfraを導入しなければTerraform・Ansibleが機能しなくなるわけではありません。①②がそれぞれ正常に完了すれば、両ツールは従来通りの役割を果たします。③はその後段に置かれる、パイプライン全体としての最終確認という位置づけにとどまります。

---

[↑ 目次に戻る](#-目次)

---


## 8. まとめ

この回で整理した内容を確認します。

* `terraform apply`（`terraform plan`）の成功はtfstateとの整合性を、`ansible-playbook`の成功は各タスクの実行結果を、それぞれ自分の管理範囲の中でのみ示している
* 両者が独立して動く以上、パイプライン全体として意図した状態になっているかどうかは、どちらの成功報告からも直接には保証されない
* Testinfraは`docker`・`ssh`いずれのバックエンドでも、Terraform・Ansibleどちらの結果にも依存しない独立した検証を行えることを実機で確認した
* `docker`バックエンドはDocker APIに直接接続し、`ssh`バックエンドはSSH経由で接続する。同一のテストコードのまま、実行時のオプション指定だけで両者を切り替えられる
* Ansibleが実行するタスクの内容によっては、Ansibleが投入した設定そのものではなく、そのタスクが依拠している前提条件を検証対象とする設計もありうる
* ローカル環境では`docker`バックエンドで、CI環境では`ssh`バックエンドで検証する使い分けが可能で、同じテストコードをどちらの環境でも使い回せることを実機で確認した
* この検証はパイプライン全体の最後に置く第三者チェックであり、必須の仕組みではなく運用上の担保として位置づけられる

---

[↑ 目次に戻る](#-目次)

---

## 9. 次回予告

**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** では、Terraformの責務を状態の出力に限定する疎結合設計への移行を、**[第32回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/)** では、GitHub Actionsを用いたCI環境の構築を、**[第33回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-33/)** では、`triggers`によるAnsible実行の抑制を、それぞれ扱いました。第34回となる今回は、接続させた結果、パイプライン全体が本当に意図通りに完了したことを誰がどう確認するかを扱いました。TerraformとAnsibleそれぞれの成功報告が互いの管理範囲を検証し合っていない構造を整理したうえで、Testinfraによる独立した状態検証を、ローカル環境（`docker`バックエンド）とCI環境（`ssh`バックエンド）の両方で実機検証を交えて確認しました。

次回は、Terraformのモジュール設計とAnsibleのロール（Role/Collection）の粒度を揃え、再利用性を高める設計パターンを扱います。

**[次回：第35回：共通パーツのモジュール化（Terraformモジュール／Ansibleロール）](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-35/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第33回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-33/)　｜　[次の記事：【Ansible×Terraform編】第35回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-35/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」シリーズ統合ブログ** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 10. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

### 第4部：改善、CI/CD自動化編

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)**|状態出力を介した疎結合なパイプライン設計|Terraformの`output`を中間データ（JSON/Environment）として抽出し、Ansibleの動的インベントリや変数として渡すパイプラインの分離設計。|
|**[第32回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/)**|GitHub Actionsを用いたプロビジョニングコードの自動テスト環境構築|CI/CD（GitHub Actions）上でTerraform実行によるコンテナ起動からAnsible適用までの自動テスト（E2E）を組み込む手法。|
|**[第33回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-33/)**|`triggers`を用いたAnsible再実行の最適化設計|`null_resource`や`terraform_data`の`triggers`／`triggers_replace`を使い、設定ファイル変更時のみAnsibleを発火させる設計。|
|**[第34回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-34/)**|Testinfraによる状態検証を組込んだCI/CDパイプライン|Ansible適用後の状態（ポート、ファイル、プロセス）をTestinfra（Python）でテストし、パイプラインの成否を判定する自動化設計。|
|**[第35回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-35/)**|共通パーツのモジュール化（Terraformモジュール／Ansibleロール）|Terraformのモジュール設計とAnsibleのロール（Role/Collection）の粒度を揃え、再利用性を高める設計パターン。|
|**[第36回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-36/)**|プラグインおよびパッケージのキャッシュによる開発効率の向上|Terraformのプラグインキャッシュとaptパッケージキャッシュにより、検証サイクルの待ち時間を短縮する手法。|
|**[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)**|定期実行による構成ドリフトの自動検知と収束パイプライン|スケジュール実行（Cron／GitHub Actions）で`ansible-playbook --check`を流し、実際の構成差分（ドリフト）を検知し、差分があった場合のみ本実行して自動収束させる設計。|
|**[第38回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-38/)**|インフラコード（HCL／Playbook）からの仕様書、構成図の自動生成|`terraform-docs`や`ansible-autodoc`等を活用し、コード更新と同時に仕様書や依存関係図を自動更新するパイプライン構築。|
|**[第39回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-39/)**|既存インフラ運用知識とInfrastructure as Code（IaC）のシナジー|手動運用（CLI/Shell）のノウハウを、TerraformとAnsibleという2大ツールにどう分解、再構築していくかの比較考察。|
|**[第40回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-40/)**|改善、CI/CD編まとめ：プロビジョニング自動化の成熟度モデル|手動実行から状態連携、CI/CD化、自動収束（Level 1〜4）に至るまでのインフラ自動化の成熟度の整理。|                                               |

---

[↑ 目次に戻る](#-目次)

---
