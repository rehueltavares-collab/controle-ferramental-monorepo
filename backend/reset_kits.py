from app.database import SessionLocal
from app import models

# Aqui você define os kits padrão por setor.
# Ajusta depois se quiser.
KITS_POR_SETOR = {
  "Civil": [("Kit Civil", "BASICO")],
  "Hidraulica / Esgoto": [("Kit Hidráulica", "BASICO")],
  "Carpintaria": [("Kit Carpintaria", "BASICO")],
  "Gesso e divisórias": [("Kit Gesso", "BASICO")],
  "Jardinagem / plantio": [("Kit Jardinagem", "BASICO")],
  "Pintura": [("Kit Pintura", "BASICO")],
  "Vidro / Alumínio": [("Kit Vidro/Alumínio", "BASICO")],
  "Refigeração / Gás": [("Kit Refrigeração/Gás", "BASICO")],
  "Instalações Eletricas": [("Kit Elétrica", "BASICO")],
  "Serralheria (ferro)": [("Kit Serralheria", "BASICO")],
}

def main():
  db = SessionLocal()
  try:
    # Remove kit lixo "string" e kits sem setor válido
    db.query(models.Kit).filter(models.Kit.nome == "string").delete(synchronize_session=False)
    db.query(models.Kit).filter((models.Kit.setor_id == 0) | (models.Kit.setor_id == None)).delete(synchronize_session=False)

    # Remove setor lixo "string"
    db.query(models.Setor).filter(models.Setor.nome == "string").delete(synchronize_session=False)

    db.commit()

    setores = db.query(models.Setor).all()
    setores_map = {s.nome: s.id for s in setores}

    inseridos = 0
    pulados = 0

    for setor_nome, kits in KITS_POR_SETOR.items():
      setor_id = setores_map.get(setor_nome)
      if not setor_id:
        # Se o setor não existe ainda, cria
        s = models.Setor(nome=setor_nome)
        db.add(s)
        db.commit()
        db.refresh(s)
        setor_id = s.id
        setores_map[setor_nome] = setor_id

      for kit_nome, kit_tipo in kits:
        existe = db.query(models.Kit).filter(models.Kit.setor_id==setor_id, models.Kit.nome==kit_nome).first()
        if existe:
          pulados += 1
          continue
        db.add(models.Kit(nome=kit_nome, tipo=kit_tipo, setor_id=setor_id))
        inseridos += 1

    db.commit()
    print(f"OK. Kits inseridos: {inseridos} | pulados: {pulados}")
  finally:
    db.close()

if __name__ == "__main__":
  main()
