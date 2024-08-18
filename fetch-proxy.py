import requests

def fetch_proxies():
    proxy_list_url = "https://api.proxyscrape.com/?request=displayproxies&proxytype=http"
    response = requests.get(proxy_list_url)
    proxies = response.text.splitlines()
    return proxies

def save_proxies_to_file(proxies, filename):
    with open(filename, 'w') as file:
        for proxy in proxies:
            file.write(f"'{proxy}'\n")

proxies_list = fetch_proxies()
save_proxies_to_file(proxies_list, "proxies.txt")
