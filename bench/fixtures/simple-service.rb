require 'net/http'

class WeatherService
  def initialize(api_key)
    @api_key = api_key
  end

  def fetch_forecast(city)
    uri = URI("https://api.weather.example.com/forecast?city=#{city}&key=#{@api_key}")
    response = Net::HTTP.get_response(uri)
    JSON.parse(response.body)
  end
end
