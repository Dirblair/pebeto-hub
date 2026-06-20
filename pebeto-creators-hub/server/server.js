// 1. Test Health
fetch('https://pebeto-creators-hub-h1j0.onrender.com/api/health')
  .then(r => r.json())
  .then(console.log);

// 2. Test Upload (in browser console)
const formData = new FormData();
const canvas = document.createElement('canvas');
canvas.width = 200;
canvas.height = 200;
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#ff0000';
ctx.fillRect(0, 0, 200, 200);
ctx.fillStyle = '#ffffff';
ctx.font = '30px Arial';
ctx.fillText('TEST', 60, 110);

canvas.toBlob((blob) => {
  formData.append('media', blob, 'test-image.jpg');
  formData.append('caption', 'Test upload');
  formData.append('category', 'Art');

  fetch('https://pebeto-creators-hub-h1j0.onrender.com/api/community/posts', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${localStorage.getItem('pebeto_token')}` },
    body: formData
  })
  .then(r => r.json())
  .then(data => console.log('Upload result:', data))
  .catch(e => console.error('Error:', e));
});
