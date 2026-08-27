---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第28回：異種OS（Windowsターゲット）混在環境における接続プロトコルの制約'
description: 'AnsibleがWindowsターゲットに接続する際はSSHではなくWinRMプロトコルを使用するため、認証、暗号化方式の前提がLinuxターゲットとは根本的に異なる構造を整理する。証明書エラー、暗号化プロトコル不一致によって通信が拒否される原因とその対処を、概念、アーキテクチャ解説として扱う。'
pubDate: '2026-08-27'
category: 'infra'
tags: ['Ansible', 'Terraform', 'WinRM', 'Windows', 'IaC']
seriesId: 'ansible-terraform-part3'
seriesNo: 28
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-29/'
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
2. [この回の位置づけ：概念、アーキテクチャ解説として構成する理由](#2-この回の位置づけ概念アーキテクチャ解説として構成する理由)
3. [接続プロトコルの違い：SSHからWinRMへ](#3-接続プロトコルの違いsshからwinrmへ)
4. [認証方式の選択肢](#4-認証方式の選択肢)
5. [証明書エラーの発生構造](#5-証明書エラーの発生構造)
6. [暗号化プロトコルの不一致](#6-暗号化プロトコルの不一致)
7. [コンテナ化の限界とTerraform×Ansibleの文脈での位置づけ](#7-コンテナ化の限界とterraformansibleの文脈での位置づけ)
8. [まとめ](#8-まとめ)
9. [次回予告](#9-次回予告)
10. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#10-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

「Ansibleで管理するなら、接続方式はどのOSでも同じ」と考えたことはないでしょうか。

**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** から **[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)** までは、Linux、コンテナ環境を対象に、ネットワーク、ログ、並列実行、認証、再起動といった問題を扱ってきました。これらの回で前提としてきた接続方式は、いずれもSSHです。**[第28回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-28/)** となる今回は、対象OSがWindowsに変わることで、この前提そのものが崩れる場面を扱います。

AnsibleはWindowsターゲットに対して、SSHではなくWinRM（Windows Remote Management）というプロトコルを使って接続します。WinRMはHTTP、HTTPSベースのプロトコルであり、認証方式や暗号化の扱いは、SSHの公開鍵認証とは根本的に異なります。この違いを理解しないまま設定すると、証明書検証エラーや暗号化方式の不一致によって、接続そのものが拒否されます。

この回で扱う問いは、「Linux、コンテナ環境で前提としてきた接続の仕組みが、Windowsターゲットではどこまで通用しなくなるのか」です。

---

[↑ 目次に戻る](#-目次)

---

## 2. この回の位置づけ：概念、アーキテクチャ解説として構成する理由

まず、この回に限り実機検証を行わないことを明示します。

**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** から **[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)** までの検証環境は、Ubuntu-Control上で動作するDocker Engineであり、Linuxベースのホストです。この環境は、Windowsコンテナ、Windows VMを実行する基盤を持ちません。Windows ServerをDockerコンテナとして動かすには、Windowsホスト上のコンテナ実行基盤が必要であり、Linux上のDocker Engineでは実現できません。

この制約により、今回は「実機で再現し、その結果を示す」というこれまでの構成ではなく、実務でWindows ServerをTerraform、Ansibleで管理する際の構造的な注意点を、Linux、コンテナ環境で扱ってきた接続アーキテクチャとの対比を軸にした、概念、アーキテクチャ解説として構成します。

```
本回は実機検証ではなく、構造解説を中心に進めます。
検証環境（Linux、Docker）ではWindowsターゲットを直接構築できないため、
WinRMの認証、暗号化の仕組みを、これまでのSSH接続の構造と対比しながら整理します。
```

---

[↑ 目次に戻る](#-目次)

---

## 3. 接続プロトコルの違い：SSHからWinRMへ

この回の前提となる、プロトコルそのものの違いを整理します。

**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** から **[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)** で扱ってきたLinux、コンテナターゲットは、SSH（ポート22、検証環境ではコンテナのマッピングポート2221から2223）を使って接続していました。これに対し、Windowsターゲットは、WinRM（HTTP：5985、HTTPS：5986）を使って接続します。

```
【これまで扱ってきたLinux、コンテナターゲットへの接続】
ansible_connection: ssh
ansible_port: 2221（target-node1の場合）

【Windowsターゲットへの接続（概念）】
ansible_connection: winrm
ansible_port: 5986
ansible_winrm_transport: ntlm
```

Ansibleのインベントリでは、OSごとにグループを分け、グループ単位で接続方式を切り替えるという構成が一般的です。以下は、この構成を示す概念上の例です。

```ini
[target_nodes]
target-node1 ansible_host=127.0.0.1 ansible_port=2221
target-node2 ansible_host=127.0.0.1 ansible_port=2222
target-node3 ansible_host=127.0.0.1 ansible_port=2223

[windows_servers]
winnode1 ansible_host=192.168.1.24

[windows_servers:vars]
ansible_connection=winrm
ansible_port=5986
```

このように、AnsibleはOSごとに接続方式そのものを切り替える設計になっており、SSHはあくまでLinux系ターゲットにおける接続方式の1つという位置づけになります。次のセクションでは、このWinRM接続における認証方式の選択肢を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 4. 認証方式の選択肢

WinRM接続で使える認証方式を整理します。

|認証方式|前提環境|特徴|
|---|---|---|
|Basic|ワークグループ|認証情報が平文に近い形でやり取りされるため、HTTPSが必須|
|NTLM|ワークグループ、AD|ドメインなしの環境でも扱いやすい|
|Kerberos|AD必須|ドメイン環境が前提のため、今回は深く扱わない|
|証明書|要クライアント証明書配布|構築コストが高い|

実務でワークグループ環境を組む場合、これらの中では、NTLM認証が扱いやすい選択肢になります。インベントリでは、以下のように接続方式を指定します。

```ini
[windows_servers:vars]
ansible_winrm_transport=ntlm
```

Kerberos認証は、Active Directoryへの参加が前提になるため、ワークグループ環境では選択肢に入りません。証明書認証は、クライアント証明書の発行、配布という運用コストが加わるため、小規模な環境では採用のハードルが高くなります。この2つの選択肢は、AD環境や、証明書運用の基盤がすでに整っている環境向けの選択肢という位置づけになります。

次のセクションでは、認証方式とは別のレイヤーで発生する、証明書検証にまつわるエラーを扱います。

---

[↑ 目次に戻る](#-目次)

---

## 5. 証明書エラーの発生構造

証明書検証にまつわるエラーの発生構造を整理します。

WinRMをHTTPS（5986）で接続する場合、通信はTLSによって暗号化されます。このとき、Windows側が提示する証明書が正規の認証局（CA）に署名されたものでなければ、クライアント側は証明書の検証に失敗し、接続を拒否します。検証環境や、構築初期のワークグループ環境では、正規のCA証明書ではなく自己署名証明書が使われることが多く、この場合、デフォルト設定では次のようなエラーが発生します。

```
ansible winnode1 -m win_ping
winnode1 | UNREACHABLE! => {
    "msg": "ssl: [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed"
}
```

このエラーは、通信経路や認証情報そのものに問題があるのではなく、TLS証明書の検証という、通信の前段階で発生しています。Ansible側には、この証明書検証の扱いを制御する`ansible_winrm_server_cert_validation`という変数が用意されており、`ignore`に設定することで、証明書検証をスキップできます。

```ini
[windows_servers:vars]
ansible_winrm_server_cert_validation=ignore
```

この設定は、あくまで自己署名証明書を使う検証環境や構築初期段階での回避策です。本番環境では、正規のCA証明書を発行、運用したうえで、証明書検証を有効にした状態を維持することが前提になります。

次のセクションでは、この証明書検証とは別のレイヤーで発生する、暗号化プロトコルの不一致を扱います。

---

[↑ 目次に戻る](#-目次)

---

## 6. 暗号化プロトコルの不一致

証明書検証とは別のレイヤーで発生する、暗号化方式の不一致を整理します。

セクション5で扱った証明書検証は、TLSレベルの暗号化にまつわる問題でした。しかし、WinRMにはこれとは別に、メッセージ暗号化という、NTLMやKerberosのセッション単位で行われる暗号化のレイヤーが存在します。Ansible側のpywinrmライブラリが対応する暗号化方式と、Windows側で有効になっている暗号化方式が一致しない場合、証明書の検証を通過していても、次のようなエラーによって接続が拒否されます。

```
ansible winnode1 -m win_ping
winnode1 | UNREACHABLE! => {
    "msg": "wsman: unencrypted communication is not supported"
}
```

このエラーは、HTTP（5985）で接続する場合に発生しやすくなります。HTTPで接続する場合、TLSによる暗号化が働かないため、WinRM自体のメッセージ暗号化を明示的に有効にしておく必要があります。

```ini
# HTTP（5985）を使う場合に必要な設定
[windows_servers:vars]
ansible_winrm_message_encryption=auto
```

一方、HTTPS（5986）で接続する場合は、TLSによる暗号化がすでに通信全体を覆っているため、この`ansible_winrm_message_encryption`の設定は不要になります。同じ「暗号化されていない」というエラーメッセージであっても、原因はTLSの証明書検証（セクション5）とは異なるレイヤーにあるという点が、この回で押さえておくべき整理です。

次のセクションでは、ここまで整理してきた接続の構造を踏まえ、この回をシリーズ全体の文脈に接続します。

---

[↑ 目次に戻る](#-目次)

---

## 7. コンテナ化の限界とTerraform×Ansibleの文脈での位置づけ

ここまで整理してきた接続の構造を踏まえ、この回をシリーズ全体の文脈に接続します。

**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-01/)** から **[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)** までの検証環境は、Linuxターゲットをコンテナ化することで、軽量な検証を実現してきました。Windowsの場合、OSカーネル、ライセンス、起動コストの制約から、同等のコンテナ化、軽量検証が実務上も難しいという構造上の非対称性があります。

```
Linux、コンテナターゲット
　→ 軽量、検証環境の構築コストが低い、本シリーズ全体で採用

Windowsターゲット
　→ OSライセンス、起動コスト、コンテナ実行基盤の制約により、
　　同等の軽量検証が難しい
```

この非対称性は、検証環境の話にとどまらず、実務でTerraform、Ansible環境にWindowsを組み込む際のハードルの1つになります。**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-12/)** では、Terraformの初期化スクリプトやコンテナ起動定義によって、OS内部の設定が投入される構造を扱いました。Windowsの場合、この初期化の前提そのものが異なります。

```
Linux、コンテナ環境
　→ コンテナ起動定義でSSHDが最初から有効な状態にできる

Windows環境
　→ Unattend.xml等の初期化スクリプトでWinRM自体を
　　明示的に有効化しておく必要がある
　→ この初期設定を怠ると、Ansibleから一切到達できない状態になる
```

TerraformでWindowsリソースを作成する場合、リソースの作成が完了しただけでは、AnsibleがWinRM経由で接続できる状態にはなりません。WinRM自体をOSイメージ、起動スクリプト側で有効化しておくという、Linux、コンテナ環境にはなかった前提が加わります。

---

[↑ 目次に戻る](#-目次)

---

## 8. まとめ

この回で整理した内容を確認します。

* AnsibleはWindowsターゲットに対して、SSHではなくWinRM（HTTP：5985、HTTPS：5986）を使って接続する。インベントリでは、OSごとにグループを分け、`ansible_connection`をグループ単位で切り替える構成が一般的である
* WinRM接続で使える認証方式には、Basic、NTLM、Kerberos、証明書の4種類があり、ワークグループ環境ではNTLMが扱いやすい。Kerberosはドメイン環境が前提となり、証明書認証は配布運用のコストが高い
* WinRM HTTPS接続時、自己署名証明書を使う環境ではデフォルト設定で証明書検証エラーが発生する。`ansible_winrm_server_cert_validation`を`ignore`に設定することで検証をスキップできるが、これは検証環境や構築初期段階での回避策であり、本番環境では正規のCA証明書運用が前提になる
* 証明書検証とは別のレイヤーで、WinRMのメッセージ暗号化方式が一致しない場合にも接続が拒否される。HTTP（5985）で接続する場合は`ansible_winrm_message_encryption`の明示的な設定が必要になるが、HTTPS（5986）ではTLSによる暗号化がすでに通信を覆っているため、この設定は不要になる
* Linuxターゲットがコンテナ化によって軽量な検証を実現してきたのに対し、Windowsは OSライセンス、起動コストの制約から同等の軽量検証が難しいという構造上の非対称性がある。TerraformでWindowsリソースを作成する場合も、リソースの作成完了だけでは接続可能な状態にならず、Unattend.xml等の初期化スクリプトでWinRM自体を明示的に有効化しておく必要がある

---

[↑ 目次に戻る](#-目次)

---

## 9. 次回予告

**[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)** では、OS再起動という正規の操作が引き起こす接続断絶を、Terraformの`local-exec`がどう受動的に観測するかを整理しました。**[第28回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-28/)** となる今回は、対象OSの違いに視点を移し、SSHではなくWinRMを使うWindowsターゲットにおいて、認証方式、証明書検証、暗号化方式の不一致がどのように接続拒否につながるかを整理しました。

次回は、対象OSの違いから離れ、プロキシ環境下でAnsible Galaxy（外部コレクション）の取得が失敗し、インフラ構築処理全体が失敗する問題を扱います。

**[次回：第29回：プロキシ環境等における外部コレクション（Ansible Galaxy）の取得失敗](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-29/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)　｜　[次の記事：【Ansible×Terraform編】第29回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-29/)**

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

### 第3部：トラブルシューティング、デバッグ編

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)**|統合実行時におけるネストされたエラーログの解析手法|Terraformの`local-exec`経由で実行されたAnsibleのエラーログから、原因がTerraform側（HCL、State）かAnsible側（Playbook、タスク）かを特定する手法。|
|**[第22回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-22/)**|マルチネットワーク環境におけるインターフェース競合|複数ネットワーク（Dockerネットワーク等）をアタッチした際、Ansibleの`ansible_default_ipv4`や接続IPの自動検出が意図しないインターフェースに引きずられる問題。|
|**[第23回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-23/)**|大容量ファイル転送、重いタスク実行時におけるSSHタイムアウト|Ansibleで大きなアセットや大量のパッケージを転送、適用する際、Terraform側のプロビジョナータイムアウトに引っかかる可能性がある問題を扱う。|
|**[第24回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-24/)**|並列実行時における実行ホストのシステムリソース枯渇対策|`parallelism`や`forks`設定により、大量のリソース構築とAnsibleプロビジョニングが同時に走った場合、ホストのCPU、メモリ、ファイルディスクリプタが枯渇しうる問題を扱う。|
|**[第25回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-25/)**|構文チェックツール（HCL構文、ansible-lint）の競合緩和|両ツールの静的解析ツール（`terraform fmt`、`ansible-lint`）を導入した際、コード記述ルールや命名規則の不一致でCIが通らなくなる問題。|
|**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)**|管理者権限（sudo）実行時におけるパスワード入力のプロンプト停止|Terraformのlocal-exec経由でAnsibleのbecomeを実行する際、パスワード入力を要求するオプションを指定した場合に限り、非対話実行環境で処理が無応答のまま停止する問題。|
|**[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)**|再起動、再生成に伴うプロビジョニング断絶|AnsibleのrebootモジュールによるOS再起動時、接続断絶が正常な過程か異常な停止かをTerraformのlocal-execが区別できず、外側のタイムアウトと競合する問題。|
|**[第28回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-28/)**|異種OS（Windowsターゲット）混在環境における接続プロトコルの制約|SSHではなくWinRM等を用いる特殊プロトコル環境での接続、権限エラー。実務でWindows ServerをAnsible×Terraformで管理する際の構造的注意点を扱う概念解説回。|
|**[第29回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-29/)**|プロキシ環境等における外部コレクション（Ansible Galaxy）の取得失敗|インフラ構築処理の途中で外部ネットワーク（Ansible Galaxy等）への依存が切れ、Terraformの処理全体が失敗する問題。|
|**[第30回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-30/)**|デバッグフラグの組み合わせによるログ解析の高度化|Terraformの`TF_LOG`とAnsibleの`-vvvv`を組み合わせ、接続遅延や処理遅延のボトルネックを特定、解消する手法。|

---

[↑ 目次に戻る](#-目次)

---
