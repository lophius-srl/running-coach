// Fixture SYNTHÉTIQUE de activities.csv (export de compte Strava, en anglais), écrite d'après le
// format connu et non copiée d'un vrai export : à remplacer par une version anonymisée du fichier
// du propriétaire dès qu'il est disponible (ADR 0004). Embarquée en chaîne pour être lisible sous
// workerd (pas de fs) et à l'abri de Prettier et des conversions CRLF de Git.
// Contenu : BOM, colonnes « Distance » et « Elapsed Time » en double, descriptions avec virgules,
// guillemets et retours à la ligne ; 4 courses valides (Run, Trail Run avec virgule décimale et sans
// distance en mètres, Virtual Run sans Moving Time, Run), 2 autres sports (Ride, Swim) et 2 courses
// invalides (date impossible, allure de 30 s/km).
export const ACTIVITIES_SAMPLE_CSV = `\uFEFFActivity ID,Activity Date,Activity Name,Activity Type,Activity Description,Elapsed Time,Distance,Max Heart Rate,Relative Effort,Commute,Activity Private Note,Activity Gear,Filename,Athlete Weight,Bike Weight,Elapsed Time,Moving Time,Distance,Max Speed,Average Speed,Elevation Gain,Elevation Loss,Elevation Low,Elevation High,Max Grade,Average Grade,Average Positive Grade,Average Negative Grade,Max Cadence,Average Cadence,Max Heart Rate,Average Heart Rate
4884325112,"Mar 14, 2021, 7:02:11 AM",Footing du dimanche,Run,"Belle sortie, jambes ""lourdes""
retour au calme",3125,10.02,171.0,,false,,Pegasus 37,activities/5203940231.fit.gz,70.0,,3125.0,3010.0,10021.3,4.5,3.3,87.0,87.0,30.0,90.0,12.5,0.0,3.1,-3.0,92,84,171.0,152.3
4890000001,"Mar 16, 2021, 6:15:00 PM",Vélotaf,Ride,,2400,15.30,,,false,,Vélo,activities/5210000001.fit.gz,70.0,,2400.0,2280.0,15302.0,4.5,3.3,45.0,45.0,30.0,90.0,12.5,0.0,3.1,-3.0,92,84,,
4950000002,"Apr 3, 2021, 9:30:00 AM","Trail des crêtes, boucle nord",Trail Run,,9600,"21,10",182.0,,false,,Speedgoat,activities/5300000002.gpx,70.0,,9600.0,9000.0,,4.5,3.3,850.0,850.0,30.0,90.0,12.5,0.0,3.1,-3.0,92,84,182.0,
4960000003,"Apr 5, 2021, 12:10:00 PM",Natation,Swim,,2100,1.50,,,false,,,,70.0,,2100.0,1900.0,1500.0,4.5,3.3,,,30.0,90.0,12.5,0.0,3.1,-3.0,92,84,,
5100000004,"Dec 31, 2021, 11:59:59 PM",Tapis de fin d'année,Virtual Run,,1800,5.00,,,false,,,,70.0,,1800.0,,5000.0,4.5,3.3,,,30.0,90.0,12.5,0.0,3.1,-3.0,92,84,,140.0
5200000005,"Feb 30, 2022, 7:00:00 AM",Date impossible,Run,,3000,10.00,,,false,,,,70.0,,3000.0,3000.0,10000.0,4.5,3.3,,,30.0,90.0,12.5,0.0,3.1,-3.0,92,84,,
5300000006,"Jun 1, 2023, 8:00:00 AM",GPS fou,Run,,300,10.00,,,false,,,,70.0,,300.0,300.0,10000.0,4.5,3.3,,,30.0,90.0,12.5,0.0,3.1,-3.0,92,84,,
16000000007,"Oct 28, 2026, 6:45:03 AM","Fractionné 10x400, piste",Run,"Échauffement 20 min
10 x 400 m (r = 1 min 30)
Retour au calme",3700,9.80,188.0,,false,,Pegasus 41,activities/17000000007.fit.gz,70.0,,3700.0,2950.0,9804.6,4.5,3.3,22.0,22.0,30.0,90.0,12.5,0.0,3.1,-3.0,92,84,188.0,161.0
`;
