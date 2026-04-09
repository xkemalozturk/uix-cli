# UIX

Monorepo veya tek paket projelerde registry component kurulumu için CLI.

## Kurulum

```bash
bun install
bun link
```

## Hızlı Başlangıç

```bash
bunx uix <url|alias>
```

Örnek:

```bash
bunx uix shadcn
bunx uix diceui
```

## Komutlar

### Registry Üzerinden Kurulum

```bash
# normal kurulum
bunx uix <url|alias>

# kurmadan önce hangi componentlerin kurulacağını yazdır
bunx uix <url|alias> --dry

# mevcut dosya kontrolünü kapat
bunx uix <url|alias> --no-diff

# hedef klasörü belirt (monorepo için önerilir)
bunx uix <url|alias> --cwd=packages/ui
```

### Shadcn Native Mod

```bash
# shadcn add interactive (component seçimi)
bunx uix init shadcn --cwd=packages/ui

# tüm componentleri kur
bunx uix init shadcn --all --cwd=packages/ui
```

Not: `init shadcn` modunda `--cwd` verilmezse ve `packages/ui` varsa otomatik orası kullanılır.

### Init

```bash
# yeni ui paketi oluştur + registry kurulumu
bunx uix init --name=@myorg/ui --dir=packages/ui <url|alias>

# yeni ui paketi oluştur, ardından shadcn native tüm kurulum
bunx uix init --name=@workspace/ui --dir=packages/ui
bunx uix init shadcn --all --cwd=packages/ui
```

### Diğer

```bash
# registry listesini göster
bunx uix list

# bir önceki kurulumda başarısız olanları tekrar dene
bunx uix retry --cwd=packages/ui

# kurulu component güncellemelerini kontrol et
bunx uix outdated --cwd=packages/ui

# sadece güncellemesi olan componentleri overwrite ederek güncelle
bunx uix update --cwd=packages/ui
```
