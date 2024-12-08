const canvas = document.getElementById('myCanvas');
const ctx = canvas.getContext('2d');

// Définir la taille du canvas
canvas.width = 450;
canvas.height = 350;

let isDrawing = false;
let lastX = 0;
let lastY = 0;

canvas.addEventListener('mousedown', startDrawing);
canvas.addEventListener('mousemove', draw);
canvas.addEventListener('mouseup', stopDrawing);
canvas.addEventListener('mouseout', stopDrawing);

// Pour le tactile
canvas.addEventListener('touchstart', startDrawing);
canvas.addEventListener('touchmove', draw);
canvas.addEventListener('touchend', stopDrawing);

function startDrawing(e) {
    isDrawing = true;
    [lastX, lastY] = getCoordinates(e);
}

function draw(e) {
    if (!isDrawing) return;

    const [x, y] = getCoordinates(e);

    ctx.strokeStyle = 'red';
    ctx.lineWidth = 5;

    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(x, y);
    ctx.stroke();

    [lastX, lastY] = [x, y];
}

function stopDrawing() {
    isDrawing = false;
}

function getCoordinates(e) {
    if (e.type.startsWith('touch')) {
        return [e.touches[0].clientX - canvas.offsetLeft, e.touches[0].clientY - canvas.offsetTop];
    } else {
        return [e.clientX - canvas.offsetLeft, e.clientY - canvas.offsetTop];
    }
}

// Enregistrer le dessin en chaine de caractères
// const saveBtn = document.getElementById('saveBtn');
// saveBtn.addEventListener('click', () => {
//     const dataURL = canvas.toDataURL();
//     localStorage.setItem('canvasData', dataURL);
// });

const saveBtn = document.getElementById('saveBtn');
saveBtn.addEventListener('click', () => {

    // Créer un canvas temporaire hors écran
    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext('2d');
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;

    // Dessiner l'image de fond sur le canvas temporaire
    const background = new Image();
    background.src = 'image.png'; // Remplacez par le lien de votre image

    background.onload = () => {
        tempCtx.drawImage(background, 0, 0);

        // Dessiner le contenu du canvas principal par-dessus
        tempCtx.drawImage(canvas, 0, 0);

        // Convertir le canvas temporaire en data URL
        const dataURL = tempCanvas.toDataURL();

        // Stocker la data URL dans le localStorage
        localStorage.setItem('canvasData', dataURL);
    }
});

// Restaurer le dessin
const restoreBtn = document.getElementById('restoreBtn');
restoreBtn.addEventListener('click', () => {
    const dataURL = localStorage.getItem('canvasData');
    if (dataURL) {
        const img = new Image();
        img.src = dataURL;
        img.onload = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0);
        }
    }
});

// Télécharger le dessin en format binaire (PNG)
// const downloadBtn = document.getElementById('downloadBtn');
// downloadBtn.addEventListener('click', () => {
//     const link = document.createElement('a');
//     link.download = 'mon_dessin.png';
//     link.href = canvas.toDataURL('image/png');
//     link.click();
// });

// const downloadBtn = document.getElementById('downloadBtn');
// downloadBtn.addEventListener('click', () => {
//
//     // Créer un canvas temporaire hors écran
//     const tempCanvas = document.createElement('canvas');
//     const tempCtx = tempCanvas.getContext('2d');
//     tempCanvas.width = canvas.width;
//     tempCanvas.height = canvas.height;
//
//     // Dessiner l'image de fond sur le canvas temporaire
//     const background = new Image();
//     background.src = 'image.png'; // Remplacez par le lien de votre image
//
//     background.onload = () => {
//         tempCtx.drawImage(background, 0, 0);
//
//         // Dessiner le contenu du canvas principal par-dessus
//         tempCtx.drawImage(canvas, 0, 0);
//
//         // Créer un lien de téléchargement pour l'image fusionnée
//         const link = document.createElement('a');
//         link.download = 'mon_dessin.png';
//         link.href = tempCanvas.toDataURL('image/png');
//         link.click();
//     }
// });


const downloadBtn = document.getElementById('downloadBtn');
downloadBtn.addEventListener('click', () => {

    // Sauvegarder l'état actuel du canvas
    const dataURL = canvas.toDataURL();

    // Dessiner l'image de fond sur le canvas principal
    const background = new Image();
    background.src = 'image.png';

    background.onload = () => {
        const ratio = canvas.width / background.width;
        const newHeight = background.height * ratio;

        // Dessiner l'image de fond redimensionnée
        ctx.drawImage(background, 0, 0, canvas.width, newHeight);

        // Dessiner le contenu sauvegardé par-dessus l'image de fond
        const img = new Image();
        img.src = dataURL;
        img.onload = () => {
            ctx.drawImage(img, 0, 0);

            // Créer le lien de téléchargement
            const link = document.createElement('a');
            link.download = 'mon_dessin.png';
            link.href = canvas.toDataURL('image/png');
            link.click();
        }
    }
});
