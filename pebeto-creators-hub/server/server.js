// Test 1: Health check
fetch('https://pebeto-creators-hub-h1j0.onrender.com/api/health')
  .then(r => r.json())
  .then(data => console.log('Health:', data))
  .catch(e => console.error('Error:', e));

// Test 2: Community test
fetch('https://pebeto-creators-hub-h1j0.onrender.com/api/community/test')
  .then(r => r.json())
  .then(data => console.log('Community test:', data))
  .catch(e => console.error('Error:', e));

// Test 3: Upload (run this in browser console)
const token = localStorage.getItem('pebeto_token');
const formData = new FormData();

// Create test image
const canvas = document.createElement('canvas');
canvas.width = 100;
canvas.height = 100;
const ctx = canvas.getContext('2d');
ctx.fillStyle = 'red';
ctx.fillRect(0, 0, 100, 100);

canvas.toBlob((blob) => {
  formData.append('media', blob, 'test.jpg');
  formData.append('caption', 'Test upload');

  fetch('https://pebeto-creators-hub-h1j0.onrender.com/api/community/posts', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: formData
  })
  .then(r => r.json())
  .then(data => console.log('Upload result:', data))
  .catch(e => console.error('Upload error:', e));
});
