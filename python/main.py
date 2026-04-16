import os
import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin

def create_directory(directory):
    if not os.path.exists(directory):
        os.makedirs(directory)

def download_image(information_id, img_url, folder_path):
    img_name = os.path.join(folder_path, img_url.split("/")[-1])
    if os.path.exists(img_name):
        print(f"Already exists: {img_name}")
        return
    try:
        response = requests.get(img_url, stream=True)
        if response.status_code == 200:
            with open(img_name, 'wb') as f:
                for chunk in response.iter_content(1024):
                    f.write(chunk)
            print(f"{information_id} downloaded: {img_url}")
        else:
            print(f"Failed to download: {img_url}")
    except Exception as e:
        print(f"Error downloading {img_url}: {e}")

def download_images_from_url(information_id, url, folder_path):
    try:
        response = requests.get(url)
        soup = BeautifulSoup(response.content, 'html.parser')
        img_tags = soup.find_all('img')
        for img in img_tags:
            img_url = urljoin(url, img.get('src'))
            download_image(information_id, img_url, folder_path)
    except Exception as e:
        print(f"Error processing {url}: {e}")

images_folder = "genko_cosplay"
create_directory(images_folder)

url = f"https://cgcosplay.org/91993/"
download_images_from_url(1, url, images_folder)