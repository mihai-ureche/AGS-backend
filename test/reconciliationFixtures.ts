import { buildReconciliation } from '../src/importSalesReconciliation.js';

export const salesCsv = `Client,Serie,Data,Numar,Tip,Denumire grupa,Denumire,UM,Cantitate,Pret Intrare,TVA %,Cost,Pret vanzare fara TVA,Valoare vanzare,Adaos,Adaos/(ValoareContabila-Adaos)
Business client,BR,01/09/2026,1,AIM,Filtre,Filtru,Buc,1.00,0.00,21.00%,0.00,"5,916,626.47","5,916,626.47","5,916,626.47",0.00%
Business client,BR,02/09/2026,2,AIMS,Filtre,Filtru,Buc,-1.00,0.00,21.00%,0.00,"528,744.30","-528,744.30","-528,744.30",0.00%
`;
export const discountCsv = `DenumireGestiune,Grupa,Denumire,Cod,UM,Cantitate,Pret,Valoare,TVA %,Client,NumarDoc,SerieDoc,Data,Tip,Gestiune,PL
Depozit,Discount,Discount comercial,~111,Buc,1.00,"-229,041.31","-229,041.31",21.00%,Business client,1,BR,01/09/2026,AIM,1,1
Depozit,Discount,Discount comercial,~111,Buc,1.00,"1,306.25","1,306.25",21.00%,Business client,2,BR,02/09/2026,AIMS,1,1
`;
export const report = () => buildReconciliation(salesCsv, discountCsv, {
  month: '2026-09', salesMarker: 5387882.07, discountMarker: 227735,
});
