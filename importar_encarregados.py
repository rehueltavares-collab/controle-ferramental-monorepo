from app.database import SessionLocal
from app import models

DADOS = [
    ("Civil","Supervisor","Gilmar","21 96418-4262"),
    ("Civil","Encarregado Geral","Romulo","21 97350-6371"),
    ("Civil","Encarregado Turma","Leandro","21 96615-3437"),
    ("Civil","Encarregado Turma","Rafael","21 97498-9681"),
    ("Civil","Encarregado Turma","Iure","21 97438-0987"),
    ("Hidraulica / Esgoto","Supervisor","Bruno","21 97318-1985"),
    ("Hidraulica / Esgoto","Encarregado Turma","Fernando","21 98693-3543"),
    ("Carpintaria","Supervisor","Rodrigo Lopes","21 99008-9749"),
    ("Carpintaria","Encarregado Turma","Roberio","21 97233-4232"),
    ("Gesso e divisórias","Supervisor","Raphael","21 98823-7093"),
    ("Gesso e divisórias","Encarregado Turma","Douglas","21 98685-2727"),
    ("Jardinagem / plantio","Encarregado Turma","João","21 98271-3785"),
    ("Pintura","Supervisor","Fabricio","21 98734-6479"),
    ("Pintura","Encarregado Turma","Gabriel","21 99688-0589"),
    ("Pintura","Encarregado Turma","Heitor","21 97590-6693"),
    ("Vidro / Alumínio","Supervisor","Jonathan","21 97590-4912"),
    ("Vidro / Alumínio","Encarregado Turma","Edson","21 96695-9243"),
    ("Refigeração / Gás","Supervisor","Paulo","21 99686-6138"),
    ("Refigeração / Gás","Encarregado Turma","Matheus","21 97110-4003"),
    ("Instalações Eletricas","Supervisor","Paulo (Boor)","21 97283-2363"),
    ("Instalações Eletricas","Encarregado Turma","Marcos Vinicius","21 97310-1159"),
    ("Instalações Eletricas","Eletricista","Nathan","21 99653-4536"),
    ("Serralheria (ferro)","Supervisor","Angelo","21 99387-7515"),
    ("Serralheria (ferro)","Encarregado Turma","Uanderson","21 99946-3386"),
    ("Serralheria (ferro)","Encarregado Turma","Israel","21 99002-1130"),
]

def get_or_create_setor(db, nome):
    s = db.query(models.Setor).filter(models.Setor.nome == nome).first()
    if not s:
        s = models.Setor(nome=nome)
        db.add(s)
        db.commit()
        db.refresh(s)
    return s

def main():
    db = SessionLocal()
    try:
        inseridos = 0
        pulados = 0
        for setor_nome, funcao, nome, tel in DADOS:
            setor = get_or_create_setor(db, setor_nome)
            existe = (db.query(models.Encarregado)
                        .filter(models.Encarregado.setor_id == setor.id,
                                models.Encarregado.nome == nome)
                        .first())
            if existe:
                pulados += 1
                continue
            db.add(models.Encarregado(setor_id=setor.id, funcao=funcao, nome=nome, telefone=tel))
            inseridos += 1
        db.commit()
        print(f"Encarregados inseridos: {inseridos} | pulados: {pulados}")
    finally:
        db.close()

if __name__ == "__main__":
    main()
