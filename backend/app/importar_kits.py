import pandas as pd
from sqlalchemy.orm import Session
from app.database import SessionLocal, engine
from app import models

# -----------------------------------------
# UTIL
# -----------------------------------------

def get_or_create_setor(db: Session, nome: str):
    nome = nome.strip()
    setor = db.query(models.Setor).filter(models.Setor.nome == nome).first()
    if not setor:
        setor = models.Setor(nome=nome)
        db.add(setor)
        db.commit()
        db.refresh(setor)
    return setor


def get_or_create_kit(db: Session, nome: str, setor_id: int):
    kit = (
        db.query(models.Kit)
        .filter(models.Kit.nome == nome)
        .filter(models.Kit.setor_id == setor_id)
        .first()
    )
    if not kit:
        kit = models.Kit(nome=nome, setor_id=setor_id)
        db.add(kit)
        db.commit()
        db.refresh(kit)
    return kit


def get_item_by_patrimonio(db: Session, patrimonio: str):
    return (
        db.query(models.Item)
        .filter(models.Item.patrimonio == patrimonio.strip())
        .first()
    )


# -----------------------------------------
# IMPORTAÇÃO PRINCIPAL
# -----------------------------------------

def importar_kits():
    print("\n🔄 IMPORTANDO KITS...")
    db = SessionLocal()

    # Carregar Excel gerado pela IA
    df_classificacao = pd.read_excel("Kits_Ferramental_V1.xlsx", sheet_name="01_Itens_Classificados")
    df_kits = pd.read_excel("Kits_Ferramental_V1.xlsx", sheet_name="02_Kits")
    df_kit_itens = pd.read_excel("Kits_Ferramental_V1.xlsx", sheet_name="03_Kit_Itens")

    # Criar setores
    setores_unicos = sorted(df_classificacao["SETOR"].dropna().unique())
    mapa_setores = {}

    for nome_setor in setores_unicos:
        setor = get_or_create_setor(db, nome_setor)
        mapa_setores[nome_setor] = setor.id

    print(f"✔️ Setores importados: {len(mapa_setores)}")

    # Criar kits
    mapa_kits = {}
    for _, row in df_kits.iterrows():
        nome = row["NomeKit"]
        setor = row["Setor"]
        setor_id = mapa_setores.get(setor)

        kit = get_or_create_kit(db, nome, setor_id)
        mapa_kits[row["KitID"]] = kit.id

    print(f"✔️ Kits importados: {len(mapa_kits)}")

    # Inserir itens nos kits
    count_rel = 0
    for _, row in df_kit_itens.iterrows():
        item = get_item_by_patrimonio(db, str(row["IDENTIFICACAO"]))
        if item:
            kit_id_real = mapa_kits[row["KitID"]]

            rel = models.KitItem(
                kit_id=kit_id_real,
                item_id=item.id,
                quantidade=1
            )
            db.add(rel)

            # atualizar setor do item
            setor_nome = row["SETOR"]
            item.setor_id = mapa_setores.get(setor_nome)

            count_rel += 1

    db.commit()

    print(f"✔️ Itens alocados nos kits: {count_rel}")

    print("\n🎉 IMPORTAÇÃO FINALIZADA COM SUCESSO!\n")


if __name__ == "__main__":
    importar_kits()
